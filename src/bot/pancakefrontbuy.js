// 搶單機器人，加入底池後檢測風險買入賣出

import { ethers } from "ethers";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
dotenv.config();

// ---------------- CONFIG ----------------
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const PANCAKE_V2_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const PANCAKE_FACTORY = "0xca143ce32fe78f1f7019d7d551a6402fc5350c73";
const WBNB = "0xBB4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c".toLowerCase();
const NONFUNGIBLE_POSITION_MANAGER = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88"; // V3

const CONFIG = {
  SLIPPAGE_PERCENT: 6,
  GAS_LIMIT: 1200000,
  GAS_PRICE_GWEI: "6",
  MONITOR_INTERVAL_MS: 15000,
  BUY_BNB_AMOUNT: ethers.parseEther("0.01"),
  LARGE_SELL_THRESHOLD_BNB: ethers.parseEther("0.5"),
  TAKE_PROFIT_PERCENT: 30, // 卖出止盈百分比
  STOP_LOSS_PERCENT: 10    // 卖出止损百分比
};

// ---------------- ABIs ----------------
const erc20Abi = ["function decimals() view returns (uint8)","function symbol() view returns (string)","function approve(address,uint256)","function balanceOf(address) view returns(uint256)"];
const routerAbi = ["function getAmountsOut(uint256,address[]) view returns (uint256[])","function swapExactETHForTokens(uint256,address[],address,uint256) payable","function swapExactTokensForETHSupportingFeeOnTransferTokens(uint,uint,address[],address,uint)"];
const factoryAbi = ["event PairCreated(address indexed token0,address indexed token1,address pair,uint)","function getPair(address,address) view returns(address)"];
const v3PositionManagerAbi = [
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  "function positions(uint256 tokenId) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)",
  "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) returns (uint256 amount0,uint256 amount1)",
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) returns (uint256 amount0,uint256 amount1)"
];

const router = new ethers.Contract(PANCAKE_V2_ROUTER, routerAbi, wallet);
const factory = new ethers.Contract(PANCAKE_FACTORY, factoryAbi, provider);
const positionManager = new ethers.Contract(NONFUNGIBLE_POSITION_MANAGER, v3PositionManagerAbi, wallet);

// ---------------- MYSQL ----------------
const MYSQL_CONFIG = {
  host: process.env.MYSQL_HOST||"127.0.0.1",
  port: process.env.MYSQL_PORT?Number(process.env.MYSQL_PORT):3306,
  user: process.env.MYSQL_USER||"root",
  password: process.env.MYSQL_PASS||"",
  database: process.env.MYSQL_DB||"sniper_db"
};
let pool;
async function initDb(){
  pool = await mysql.createPool({...MYSQL_CONFIG,connectionLimit:10});
  await pool.query(`CREATE TABLE IF NOT EXISTS positions (
    id VARCHAR(128) PRIMARY KEY,
    token VARCHAR(64) NOT NULL,
    balance TEXT NOT NULL,
    decimals INT NOT NULL,
    buyCostBNB TEXT NOT NULL,
    timestamp BIGINT NOT NULL,
    sold TINYINT(1) DEFAULT 0,
    v3info JSON NULL
  );`);
  console.log("DB ready.");
}

// ---------------- DB ----------------
async function savePosition(pos){
  await pool.query("INSERT INTO positions (id,token,balance,decimals,buyCostBNB,timestamp,sold,v3info) VALUES (?,?,?,?,?,?,?,?)", [
    pos.id,pos.token.toLowerCase(),pos.balance.toString(),pos.decimals,pos.buyCostBNB.toString(),pos.timestamp,pos.sold?1:0,pos.v3info?JSON.stringify(pos.v3info):null
  ]);
}
async function updatePosition(id,remainingBalance,soldFlag=false){
  await pool.query("UPDATE positions SET balance=?,sold=? WHERE id=?",[remainingBalance.toString(),soldFlag?1:0,id]);
}
async function getOpenPositions(){
  const [rows] = await pool.query("SELECT * FROM positions WHERE sold=0");
  return rows.map(r=>({...r,balance:BigInt(r.balance),buyCostBNB:BigInt(r.buyCostBNB),sold:r.sold===1,v3info:r.v3info?JSON.parse(r.v3info):null}));
}

// ---------------- HELPERS ----------------
function slippageDown(amount,percent){return (BigInt(amount)*(100n-BigInt(percent)))/100n;}

// ---------------- V2 Buy ----------------
async function buyV2(tokenAddr,bnbAmount){
  const path=[WBNB,tokenAddr];
  const minOut=0; // 可拓展滑点
  const tx=await router.swapExactETHForTokens(minOut,path,wallet.address,Math.floor(Date.now()/1000)+120,{value:bnbAmount,gasLimit:CONFIG.GAS_LIMIT,gasPrice:ethers.parseUnits(CONFIG.GAS_PRICE_GWEI,"gwei")});
  const rec=await tx.wait();
  const token=new ethers.Contract(tokenAddr,erc20Abi,provider);
  const decimals=await token.decimals();
  const balance=await token.balanceOf(wallet.address);
  const pos=await recordNewPosition(rec.transactionHash,tokenAddr,decimals,balance,bnbAmount,null);
  console.log("V2 bought:",pos.id);
  return pos;
}

// ---------------- V3 Buy mint ----------------
async function buyV3(token0,token1,fee,amount0,amount1){
  // 自动计算最小滑点
  const amount0Min = slippageDown(amount0,CONFIG.SLIPPAGE_PERCENT);
  const amount1Min = slippageDown(amount1,CONFIG.SLIPPAGE_PERCENT);
  const tickLower=-60; // 示例
  const tickUpper=60;  // 示例
  const tx = await positionManager.mint({
    token0,token1,fee,tickLower,tickUpper,
    amount0Desired:amount0,amount1Desired:amount1,
    amount0Min,amount1Min,
    recipient:wallet.address,
    deadline:Math.floor(Date.now()/1000)+120
  });
  const rec = await tx.wait();
  const tokenId = rec.events?.[0]?.args?.tokenId || BigInt(Date.now());
  const v3info={token0,token1,fee,tickLower,tickUpper,tokenId:tokenId.toString()};
  const pos = await recordNewPosition(`V3_${tokenId}`,token0,18,amount0,amount0,v3info);
  console.log("V3 bought:",pos.id);
  return pos;
}

// ---------------- POSITION RECORD ----------------
async function recordNewPosition(txHash,tokenAddr,decimals,amountBN,buyCostBNB,v3info=null){
  const id=`${txHash}_${Date.now()}`;
  const pos={id,token:tokenAddr.toLowerCase(),balance:BigInt(amountBN),decimals,buyCostBNB:BigInt(buyCostBNB),timestamp:Date.now(),sold:false,v3info};
  await savePosition(pos);
  return pos;
}

// ---------------- SELL ----------------
async function sellToken(tokenAddr,amount){
  const token=new ethers.Contract(tokenAddr,erc20Abi,wallet);
  await token.approve(PANCAKE_V2_ROUTER,amount);
  const path=[tokenAddr,WBNB];
  const amounts = await router.getAmountsOut(amount,path);
  const minOut = slippageDown(amounts[1],CONFIG.SLIPPAGE_PERCENT);
  const tx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(amount,minOut,path,wallet.address,Math.floor(Date.now()/1000)+120,{gasLimit:CONFIG.GAS_LIMIT,gasPrice:ethers.parseUnits(CONFIG.GAS_PRICE_GWEI,"gwei")});
  await tx.wait();
  console.log("Sold:",tokenAddr);
}
async function withdrawV3(tokenId){
  const pos = await positionManager.positions(tokenId);
  if(pos.liquidity>0){
    await positionManager.decreaseLiquidity({tokenId,liquidity:pos.liquidity,amount0Min:0,amount1Min:0,deadline:Math.floor(Date.now()/1000)+120});
    await positionManager.collect({tokenId,recipient:wallet.address,amount0Max:ethers.MaxUint256,amount1Max:ethers.MaxUint256});
    console.log("V3 liquidity withdrawn:",tokenId);
  }
}
async function sellPartial(positionId,percent=null,amountAbsolute=null){
  const open=await getOpenPositions();
  const pos=open.find(p=>p.id===positionId);
  if(!pos) throw new Error("Position not found");
  let amt;
  if(percent!==null) amt=(pos.balance*BigInt(percent))/100n;
  else if(amountAbsolute!==null) amt=BigInt(amountAbsolute);
  else throw new Error("Provide percent or amountAbsolute");
  if(pos.v3info && pos.v3info.tokenId) await withdrawV3(pos.v3info.tokenId);
  else await sellToken(pos.token,amt);
  const remaining=pos.balance-amt;
  await updatePosition(positionId,remaining,remaining===0n);
  return remaining;
}

// ---------------- MONITOR ----------------
async function monitor(){
  const open=await getOpenPositions();
  for(const pos of open){
    // 止盈 / 止损
    const currentPriceBNB = pos.buyCostBNB; // 可用 getAmountsOut 实际价格计算
    const takeProfit = pos.buyCostBNB*(100n+BigInt(CONFIG.TAKE_PROFIT_PERCENT))/100n;
    const stopLoss = pos.buyCostBNB*(100n-BigInt(CONFIG.STOP_LOSS_PERCENT))/100n;
    if(currentPriceBNB>=takeProfit || currentPriceBNB<=stopLoss){
      console.log("Stop triggered, selling:",pos.id);
      await sellPartial(pos.id,100);
    }
    // 大额仓位
    if(pos.buyCostBNB>=CONFIG.LARGE_SELL_THRESHOLD_BNB){
      console.log("Large position, selling:",pos.id);
      await sellPartial(pos.id,100);
    }
    // V3撤池
    if(pos.v3info && pos.v3info.tokenId){
      const v3pos=await positionManager.positions(pos.v3info.tokenId);
      if(v3pos.liquidity===0){
        console.log("V3 pool 0 liquidity, selling:",pos.id);
        await sellPartial(pos.id,100);
      }
    }
  }
}

// ---------------- LISTENER ----------------
async function listenNewPairs(){
  factory.on("PairCreated",(token0,token1,pair,_)=>{
    console.log("New pair detected:",token0,token1);
    if(token0.toLowerCase()===WBNB) buyV2(token1,CONFIG.BUY_BNB_AMOUNT);
    else if(token1.toLowerCase()===WBNB) buyV2(token0,CONFIG.BUY_BNB_AMOUNT);
  });
}

// ---------------- MAIN ----------------
async function main(){
  await initDb();
  console.log("Sniper V2/V3 auto ready.");
  listenNewPairs();
  setInterval(monitor,CONFIG.MONITOR_INTERVAL_MS);
}

main().catch(console.error);
