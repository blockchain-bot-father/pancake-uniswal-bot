// 夾子機器人.js

import { ethers } from "ethers";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
dotenv.config();

// ---------------- CONFIG ----------------
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const PANCAKE_V2_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const WBNB = "0xBB4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c".toLowerCase();
const NONFUNGIBLE_POSITION_MANAGER = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88"; // V3

const CONFIG = {
  FRONT_RUN_BNB: ethers.parseEther("0.01"),
  SLIPPAGE_PERCENT: 5,
  GAS_MULTIPLIER: 2,
  LARGE_SWAP_THRESHOLD_BNB: ethers.parseEther("0.5"),
  MONITOR_INTERVAL_MS: 15000,
  TAKE_PROFIT_PERCENT: 30,
  STOP_LOSS_PERCENT: 10
};

// ---------------- ABIs ----------------
const routerAbi = [
  "function swapExactETHForTokens(uint256 amountOutMin,address[] calldata path,address to,uint256 deadline) payable",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn,uint256 amountOutMin,address[] calldata path,address to,uint256 deadline)"
];
const erc20Abi = [
  "function balanceOf(address) view returns(uint256)",
  "function approve(address,uint256)",
  "function decimals() view returns(uint8)"
];
const router = new ethers.Contract(PANCAKE_V2_ROUTER, routerAbi, wallet);

// ---------------- MYSQL ----------------
const MYSQL_CONFIG = {
  host: process.env.MYSQL_HOST||"127.0.0.1",
  port: process.env.MYSQL_PORT?Number(process.env.MYSQL_PORT):3306,
  user: process.env.MYSQL_USER||"root",
  password: process.env.MYSQL_PASS||"",
  database: process.env.MYSQL_DB||"sandwich_bot"
};
let pool;
async function initDb(){
  pool = await mysql.createPool({...MYSQL_CONFIG,connectionLimit:10});
  await pool.query(`CREATE TABLE IF NOT EXISTS positions (
    id VARCHAR(128) PRIMARY KEY,
    token VARCHAR(64) NOT NULL,
    balance TEXT NOT NULL,
    buyCostBNB TEXT NOT NULL,
    timestamp BIGINT NOT NULL,
    sold TINYINT(1) DEFAULT 0
  );`);
  console.log("DB ready.");
}

// ---------------- HELPERS ----------------
function slippageDown(amount,percent){return (BigInt(amount)*(100n-BigInt(percent)))/100n;}
async function savePosition(pos){
  await pool.query("INSERT INTO positions (id,token,balance,buyCostBNB,timestamp,sold) VALUES (?,?,?,?,?,?)", [
    pos.id,pos.token.toLowerCase(),pos.balance.toString(),pos.buyCostBNB.toString(),pos.timestamp,0
  ]);
}
async function updatePosition(id,remaining,soldFlag=false){
  await pool.query("UPDATE positions SET balance=?,sold=? WHERE id=?",[remaining.toString(),soldFlag?1:0,id]);
}
async function getOpenPositions(){
  const [rows] = await pool.query("SELECT * FROM positions WHERE sold=0");
  return rows.map(r=>({...r,balance:BigInt(r.balance),buyCostBNB:BigInt(r.buyCostBNB),sold:r.sold===1}));
}

// ---------------- V2 FRONT-RUN ----------------
async function frontRunV2(tokenAddr,bnbAmount,gasPrice){
  try{
    const tx = await router.swapExactETHForTokens(
      0,
      [WBNB,tokenAddr],
      wallet.address,
      Math.floor(Date.now()/1000)+30,
      {value: bnbAmount, gasPrice: gasPrice*CONFIG.GAS_MULTIPLIER}
    );
    const rec = await tx.wait();
    const token = new ethers.Contract(tokenAddr, erc20Abi, wallet);
    const balance = await token.balanceOf(wallet.address);
    const pos = {id:rec.transactionHash, token:tokenAddr, balance, buyCostBNB: bnbAmount, timestamp:Date.now()};
    await savePosition(pos);
    console.log("Front-run bought:", pos.id);
    return pos;
  }catch(e){console.error("Front-run error:",e);}
}

// ---------------- V2 BACK-RUN ----------------
async function backRunV2(pos, gasPrice){
  try{
    const token = new ethers.Contract(pos.token, erc20Abi, wallet);
    const balance = await token.balanceOf(wallet.address);
    await token.approve(PANCAKE_V2_ROUTER, balance);
    const tx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
      balance,
      0,
      [pos.token,WBNB],
      wallet.address,
      Math.floor(Date.now()/1000)+30,
      {gasPrice: gasPrice*CONFIG.GAS_MULTIPLIER}
    );
    await tx.wait();
    await updatePosition(pos.id,0,true);
    console.log("Back-run sold:", pos.id);
  }catch(e){console.error("Back-run error:",e);}
}

// ---------------- MONITOR ----------------
async function monitor(){
  const open = await getOpenPositions();
  for(const pos of open){
    const currentPriceBNB = pos.buyCostBNB; // 可扩展：用 getAmountsOut 获取实际价格
    const takeProfit = pos.buyCostBNB*(100n+BigInt(CONFIG.TAKE_PROFIT_PERCENT))/100n;
    const stopLoss = pos.buyCostBNB*(100n-BigInt(CONFIG.STOP_LOSS_PERCENT))/100n;
    if(currentPriceBNB>=takeProfit || currentPriceBNB<=stopLoss){
      console.log("Stop triggered, selling:", pos.id);
      await backRunV2(pos, ethers.parseUnits(CONFIG.GAS_MULTIPLIER.toString(),"gwei"));
    }
  }
}

// ---------------- LISTENER ----------------
provider.on("pending", async (txHash)=>{
  try{
    const tx = await provider.getTransaction(txHash);
    if(!tx) return;
    if(tx.to?.toLowerCase() === PANCAKE_V2_ROUTER.toLowerCase()){
      if(tx.value && tx.value.gt(CONFIG.LARGE_SWAP_THRESHOLD_BNB)){
        console.log("Detected large swap:", txHash);
        const path = [WBNB,"0xYourTargetTokenAddressHere"]; // 可解析 tx.data 获取 token
        const pos = await frontRunV2(path[1], CONFIG.FRONT_RUN_BNB, tx.gasPrice);
        await backRunV2(pos, tx.gasPrice);
      }
    }
  }catch(e){console.error("Pending tx error:",e);}
});

// ---------------- MAIN ----------------
async function main(){
  await initDb();
  console.log("V2 Sandwich bot ready.");
  setInterval(monitor, CONFIG.MONITOR_INTERVAL_MS);
}

main().catch(console.error);
