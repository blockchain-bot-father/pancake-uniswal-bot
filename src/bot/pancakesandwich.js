// sandwich-bot-final-auto.js
// npm install ethers mysql2 dotenv
import { ethers } from "ethers";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
dotenv.config();

// ---------------- CONFIG ----------------
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const PANCAKE_V2_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const WBNB = "0xBB4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c".toLowerCase();
const NONFUNGIBLE_POSITION_MANAGER = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";

const CONFIG = {
  FRONT_RUN_BNB: ethers.parseEther("0.01"),
  FRONT_RUN_RATIO: 0.02, // V3 前置占 pending 交易金额比例
  SLIPPAGE_PERCENT: 5,
  GAS_MULTIPLIER: 2,
  LARGE_SWAP_THRESHOLD_BNB: ethers.parseEther("0.5"),
  MONITOR_INTERVAL_MS: 15000,
  TAKE_PROFIT_PERCENT: 30,
  STOP_LOSS_PERCENT: 10,
  V3_FEE: 3000,
  V3_TICK_RANGE: 60
};

// ---------------- ABIs ----------------
const routerAbi = [
  "function swapExactETHForTokens(uint256 amountOutMin,address[] calldata path,address to,uint256 deadline) payable",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn,uint256 amountOutMin,address[] calldata path,address to,uint256 deadline)"
];
const iface = new ethers.Interface(routerAbi);

const erc20Abi = [
  "function balanceOf(address) view returns(uint256)",
  "function approve(address,uint256)",
  "function decimals() view returns(uint8)"
];
const v3Abi = [
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  "function positions(uint256 tokenId) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)",
  "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) returns (uint256 amount0,uint256 amount1)",
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) returns (uint256 amount0,uint256 amount1)"
];

const router = new ethers.Contract(PANCAKE_V2_ROUTER, routerAbi, wallet);
const positionManager = new ethers.Contract(NONFUNGIBLE_POSITION_MANAGER, v3Abi, wallet);

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
    v3TokenId VARCHAR(64),
    timestamp BIGINT NOT NULL,
    sold TINYINT(1) DEFAULT 0
  );`);
  console.log("DB ready.");
}

// ---------------- HELPERS ----------------
function slippageDown(amount,percent){return (BigInt(amount)*(100n-BigInt(percent)))/100n;}
async function savePosition(pos){
  await pool.query("INSERT INTO positions (id,token,balance,buyCostBNB,v3TokenId,timestamp,sold) VALUES (?,?,?,?,?,?,?)", [
    pos.id,pos.token.toLowerCase(),pos.balance.toString(),pos.buyCostBNB.toString(),pos.v3TokenId||null,pos.timestamp,0
  ]);
}
async function updatePosition(id,remaining,soldFlag=false){
  await pool.query("UPDATE positions SET balance=?,sold=? WHERE id=?",[remaining.toString(),soldFlag?1:0,id]);
}
async function getOpenPositions(){
  const [rows] = await pool.query("SELECT * FROM positions WHERE sold=0");
  return rows.map(r=>({...r,balance:BigInt(r.balance),buyCostBNB:BigInt(r.buyCostBNB),sold:r.sold===1,v3TokenId:r.v3TokenId}));
}
function calcGasFee(gasUsed, gasPrice){
  return gasUsed * Number(gasPrice)/1e18; // BNB
}

// ---------------- V2 FRONT-RUN ----------------
async function frontRunV2(tokenAddr,bnbAmount,gasPrice){
  try{
    const tx = await router.swapExactETHForTokens(
      0,[WBNB,tokenAddr],wallet.address,Math.floor(Date.now()/1000)+30,
      {value: bnbAmount, gasPrice: gasPrice*CONFIG.GAS_MULTIPLIER}
    );
    const rec = await tx.wait();
    const feeBNB = calcGasFee(Number(rec.gasUsed), tx.gasPrice);
    console.log(`V2 Front-run bought. Gas fee: ${feeBNB} BNB`);
    const token = new ethers.Contract(tokenAddr,erc20Abi, wallet);
    const balance = await token.balanceOf(wallet.address);
    const pos = {id:rec.transactionHash, token:tokenAddr, balance, buyCostBNB: bnbAmount, timestamp:Date.now()};
    await savePosition(pos);
    return pos;
  }catch(e){console.error("Front-run V2 error:",e);}
}

// ---------------- V2 BACK-RUN ----------------
async function backRunV2(pos, gasPrice){
  try{
    const token = new ethers.Contract(pos.token, erc20Abi, wallet);
    const balance = await token.balanceOf(wallet.address);
    await token.approve(PANCAKE_V2_ROUTER, balance);
    const tx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
      balance,0,[pos.token,WBNB],wallet.address,Math.floor(Date.now()/1000)+30,
      {gasPrice: gasPrice*CONFIG.GAS_MULTIPLIER}
    );
    const rec = await tx.wait();
    const feeBNB = calcGasFee(Number(rec.gasUsed), tx.gasPrice);
    console.log(`V2 Back-run sold. Gas fee: ${feeBNB} BNB`);
    await updatePosition(pos.id,0,true);
  }catch(e){console.error("Back-run V2 error:",e);}
}

// ---------------- 解析 pending tx token ----------------
function parseSwapTx(tx){
  try{
    const parsed = iface.parseTransaction({ data: tx.data, value: tx.value });
    if(parsed.name === "swapExactETHForTokens") return parsed.args.path[parsed.args.path.length-1];
    if(parsed.name === "swapExactTokensForETHSupportingFeeOnTransferTokens") return parsed.args.path[0];
  }catch(e){console.error("解析交易失败:", e);}
  return null;
}

// ---------------- V3 FRONT-RUN 动态 mint ----------------
async function frontRunV3AutoDynamic(tx){
  try{
    const token0 = WBNB;
    const token1 = parseSwapTx(tx);
    if(!token1) return null;

    // 根据 pending 交易金额计算前置比例
    const txValueBNB = Number(tx.value)/1e18;
    const frontAmountBNB = txValueBNB * CONFIG.FRONT_RUN_RATIO;
    const amount0Desired = ethers.parseEther(frontAmountBNB.toString());
    const amount1Desired = 0n;

    const tickLower = -CONFIG.V3_TICK_RANGE;
    const tickUpper = CONFIG.V3_TICK_RANGE;

    const txMint = await positionManager.mint({
      token0, token1, fee: CONFIG.V3_FEE,
      tickLower, tickUpper,
      amount0Desired, amount1Desired,
      amount0Min: slippageDown(amount0Desired, CONFIG.SLIPPAGE_PERCENT),
      amount1Min: 0,
      recipient: wallet.address,
      deadline: Math.floor(Date.now()/1000)+30
    });

    const rec = await txMint.wait();
    const feeBNB = calcGasFee(Number(rec.gasUsed), txMint.gasPrice);
    console.log(`V3 Front-run minted dynamic. Gas fee: ${feeBNB} BNB, frontAmount: ${frontAmountBNB} BNB`);

    const tokenId = rec.events?.[0]?.args?.tokenId || BigInt(Date.now());
    const pos = {
      id:`V3_${tokenId}`,
      token: token1,
      balance: amount0Desired,
      buyCostBNB: amount0Desired,
      v3TokenId: tokenId.toString(),
      timestamp: Date.now()
    };
    await savePosition(pos);
    return pos;
  }catch(e){console.error("V3 Front-run dynamic error:", e);}
}

// ---------------- V3 BACK-RUN ----------------
async function backRunV3(pos){
  try{
    if(!pos.v3TokenId) return;
    const tokenId = BigInt(pos.v3TokenId);
    const v3pos = await positionManager.positions(tokenId);
    if(v3pos.liquidity>0){
      const txDec = await positionManager.decreaseLiquidity({tokenId,liquidity:v3pos.liquidity,amount0Min:0,amount1Min:0,deadline:Math.floor(Date.now()/1000)+30});
      await txDec.wait();
      const txCollect = await positionManager.collect({tokenId,recipient:wallet.address,amount0Max:ethers.MaxUint256,amount1Max:ethers.MaxUint256});
      const rec = await txCollect.wait();
      const feeBNB = calcGasFee(Number(rec.gasUsed), txCollect.gasPrice);
      console.log(`V3 Back-run liquidity withdrawn. Gas fee: ${feeBNB} BNB`);
    }
    await updatePosition(pos.id,0,true);
  }catch(e){console.error("V3 Back-run error:", e);}
}

// ---------------- MONITOR ----------------
async function monitor(){
  const open = await getOpenPositions();
  for(const pos of open){
    const takeProfit = pos.buyCostBNB*(100n+BigInt(CONFIG.TAKE_PROFIT_PERCENT))/100n;
    const stopLoss = pos.buyCostBNB*(100n-BigInt(CONFIG.STOP_LOSS_PERCENT))/100n;
    const currentPriceBNB = pos.buyCostBNB; // 可扩展 getAmountsOut
    if(currentPriceBNB>=takeProfit || currentPriceBNB<=stopLoss){
      console.log("Stop triggered, selling:", pos.id);
      if(pos.v3TokenId) await backRunV3(pos);
      else await backRunV2(pos, ethers.parseUnits(CONFIG.GAS_MULTIPLIER.toString(),"gwei"));
    }
  }
}

// ---------------- PENDING LISTENER ----------------
provider.on("pending", async (txHash)=>{
  try{
    const tx = await provider.getTransaction(txHash);
    if(!tx) return;
    if(tx.to?.toLowerCase() === PANCAKE_V2_ROUTER.toLowerCase() && tx.value && tx.value.gt(CONFIG.LARGE_SWAP_THRESHOLD_BNB)){
      
      const tokenAddr = parseSwapTx(tx);
      if(!tokenAddr) return;
      console.log("Detected target token:", tokenAddr);

      // V2 前置/后置
      const posV2 = await frontRunV2(tokenAddr, CONFIG.FRONT_RUN_BNB, tx.gasPrice);
      await backRunV2(posV2, tx.gasPrice);

      // V3 动态前置/后置
      const posV3 = await frontRunV3AutoDynamic(tx);
      if(posV3) await backRunV3(posV3);
    }
  }catch(e){console.error("Pending tx error:",e);}
});

// ---------------- MAIN ----------------
async function main(){
  await initDb();
  console.log("V2+V3 Full Auto Sandwich bot ready.");
  setInterval(monitor, CONFIG.MONITOR_INTERVAL_MS);
}

main().catch(console.error);
