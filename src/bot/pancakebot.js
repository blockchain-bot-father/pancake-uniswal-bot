const { ethers } = require('ethers');
const TelegramBot = require('node-telegram-bot-api');
const config = require('../config.js');
const db = require('../database.js');
const { ErrorCode } = require("@goplus/sdk-node");
const checktoken = require('token_security_check');

class PancakeBot {

    constructor() {
        config={
             BSC_PRIVATEKEY:process.env.BSC_PRIVATEKEY,
             BSC_RPC:process.env.BSC_RPC,
             BSC_V2_FACTORY:process.env.BSC_V2_FACTORY,
             BSC_V3_FACTORY:process.env.BSC_V3_FACTORY,
             TELEGRAM_TOKEN:process.env.TELEGRAM_TOKEN,
             TELEGRAM_CHAT_ID:process.env.TELEGRAM_CHAT_ID,
        }
        
    }
    process(){

    
// 检查配置
if (!config.BSC_PRIVATEKEY ||!config.BSC_RPC || !config.BSC_V2_FACTORY || 
    !config.BSC_V3_FACTORY || !config.TELEGRAM_TOKEN || !config.TELEGRAM_CHAT_ID) {
    console.error("请检查 .env 配置是否完整！");
    process.exit(1);
}

// 初始化 provider
const provider = new ethers.JsonRpcProvider(config.BSC_RPC);

// 初始化 Telegram
const bot = new TelegramBot(config.TELEGRAM_TOKEN, { polling: false });

// V2 Factory ABI (只监听 PairCreated)
const factoryV2Abi = [
    "event PairCreated(address indexed token0, address indexed token1, address pair, uint)"
];

// V3 Factory ABI (监听 PoolCreated)
const factoryV3Abi = [
    "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"
];

const coinAbi=[
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "event Approval(address indexed owner, address indexed spender, uint256 value)",
    "function transfer(address recipient, uint256 amount) external returns (bool)",
    "function balanceOf(address) view returns (uint)",
    "function allowance(address _owner, address spender) external view returns (uint256)",
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function symbol() external view returns (string memory)",
    "function decimals() external view returns (uint8)"
];

// 连接工厂合约
const factoryV2 = new ethers.Contract(config.BSC_V2_FACTORY, factoryV2Abi, provider);
const factoryV3 = new ethers.Contract(config.BSC_V3_FACTORY, factoryV3Abi, provider);

console.log("🚀 PancakeSwap V2/V3 流动性池监控启动...");

// 监听 V2 PairCreated
factoryV2.on("PairCreated", async (token0, token1, pairAddress, index, event) => {
    try {
        
        if(token0=="0x55d398326f99059ff775485246999027b3197955"||
            token0=="0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"){
            const swap = token0;
            token0=token1;
            token1=swap;
        }

        const token0msg = await coininfo(token0,pairAddress);
        const token1msg = await coininfo(token1,pairAddress);

       
           
        await addcoin(token0,token1,pairAddress,"v2");
        const tokeninfo = await check_token(token0);
        const msg = `🔔 <b>[pancake V2] 新交易对创建</b>\n\n`
                    +token0msg+"\n"
                    +`\n\n`
                    +token1msg+"\n"
                    +`LPtoken:${pairAddress}`+"\n\n"
                    +tokeninfo;
        console.log(msg);

           
        const token1c = new ethers.Contract(token1, coinAbi, provider);
        const token1balance = (await token1c.balanceOf(pairAddress))/BigInt(10n**18n);

        if(token1=="0x55d398326f99059ff775485246999027b3197955"&&token1balance>=0){
            
            await bot.sendMessage(config.TELEGRAM_CHAT_ID, msg, {parse_mode: 'HTML',disable_web_page_preview: true });
        }else if(token1=="0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"&&token1balance>=0n){
            await bot.sendMessage(config.TELEGRAM_CHAT_ID, msg, {parse_mode: 'HTML',disable_web_page_preview: true });
        }

    } catch (err) {
        console.error("V2 通知发送失败:", err);
    }
});

// 监听 V3 PoolCreated
factoryV3.on("PoolCreated", async (token0, token1, fee, tickSpacing, poolAddress, event) => {
     try {
        
        if(token0=="0x55d398326f99059ff775485246999027b3197955"||
            token0=="0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"){
            const swap = token0;
            token0=token1;
            token1=swap;
        }

        const token0msg = await coininfo(token0,poolAddress);
        const token1msg = await coininfo(token1,poolAddress);

       
           
        await addcoin(token0,token1,poolAddress,"v3");
        const tokeninfo = await check_token(token0);
        const msg = `🔔 <b>[pancake V3] 新交易对创建</b>\n\n`
                    +token0msg+"\n"
                    +`\n\n`
                    +token1msg+"\n"
                    +`LPtoken:${poolAddress}`+"\n"
                    +tokeninfo+"\n\n";
        console.log(msg);

           
        const token1c = new ethers.Contract(token1, coinAbi, provider);
        const token1balance = (await token1c.balanceOf(poolAddress))/BigInt(10n**18n);

        if(token1=="0x55d398326f99059ff775485246999027b3197955"&&token1balance>=10000n){    
            await bot.sendMessage(config.TELEGRAM_CHAT_ID, msg, { disable_web_page_preview: true });
        }else if(token1=="0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"&&token1balance>=10n){
            await bot.sendMessage(config.TELEGRAM_CHAT_ID, msg, { disable_web_page_preview: true });
        }

    } catch (err) {
        console.error("V2 通知发送失败:", err);
    }
});

async function coininfo (token,lptoken) {
    const coin = new ethers.Contract(token, coinAbi, provider);
    
    const symbol = await coin.symbol();
    const decimals = await coin.decimals();
    const balance = await coin.balanceOf(lptoken)/BigInt(10n**decimals);

    return `名稱：${symbol}\ntoken:${token}\n底池金額：${balance}\n`;
   
}


const addcoin = async (token0,token1,pair,pool) => {
    
    try{
        const token0c = new ethers.Contract(token0, coinAbi, provider);
        const token1c = new ethers.Contract(token1, coinAbi, provider);
        const decimals0 = await token0c.decimals();
        const decimals1 = await token1c.decimals();
        const name0 = await token0c.symbol()+'';
        
    
        const token0balance = (await token0c.balanceOf(pair))/BigInt(10n**decimals0);
        const token1balance = (await token1c.balanceOf(pair))/BigInt(10n**decimals1);
        const price = Number(token1balance)/Number(token0balance);
        
        const d1 = `INSERT  INTO bot_coin(token0,token1,pair,token0_balance,token1_balance,price,name,status,pool) VALUES ('${token0}','${token1}','${pair}','${token0balance}','${token1balance}','${price}','${name0}','0','${pool}')`;
        console.log(d1)
        db.query(d1)
    }catch(e){
        console.log(e)
    }

}


let chainId = "56";
const check_token = async (address) =>{
    
   console.log(address);
   let addresses = [address];
    
// It will only return 1 result for the 1st token address if not called getAccessToken before
try{
    // const checktoken = new Checktoken();
     let res = await checktoken.check(chainId, addresses);
    if (res.code != ErrorCode.SUCCESS) {
      console.error(res.message);
      return "";
    } else {
       //  console.log(res);
       // console.log(res.result);
        // if(res.result=='{}'){
        //     check_token(address)
        // }
    // let sttring = `res.result.${address}`;
    let json = JSON.stringify(res) 
   

    const data = JSON.parse(json);
    const result1 = data.result;
    const tokenAddress = Object.keys(result1)[0]; // 提取合约地址
    const result = result1[tokenAddress]; // 取该 token 的详情

    //  console.log(result);
    //  console.log(result);
    //  console.log(is_mintable);
     let is_open_source = result.is_open_source;
     let buy_tax = result.buy_tax;
     let sell_tax = result.sell_tax;
     let is_proxy = result.is_proxy;
     let owner_address = result.owner_address;
     let owner_change_balance = result.owner_change_balance;
     let hidden_owner = result.hidden_owner;
     let selfdestruct = result.selfdestruct;
     
     let is_in_dex = result.is_in_dex;

     let cannot_buy = result.cannot_buy;
     let cannot_sell_all = result.cannot_sell_all;
     let slippage_modifiable = result.slippage_modifiable;
     let is_honeypot = result.is_honeypot; //高风险
     let transfer_pausable = result.transfer_pausable;
     let is_blacklisted = result.is_blacklisted;
     let is_whitelisted = result.is_whitelisted;
     let is_mintable = result.is_mintable;
     let owner_percent = result.owner_percent;
     let lp_holder_count = result.lp_holder_count;
     let is_airdrop_scam = result.is_airdrop_scam;
     let creator_address = result.creator_address;
     
    
     let str = '\n\n';
     
    str += `合約開源：${is_open_source? '是 ✅' : '否 🔴'}\n`
    str += `買稅：${typeof buy_tax=="undefined"?0:buy_tax}  \n賣稅：${typeof sell_tax=="undefined"?0:sell_tax}\n`
    str += `蜜罐：${is_honeypot?'是（不能買） 🔴' : '否 ✅'}\n`
    str += `是否可增發：${is_mintable?'是 🔴' : '否 ✅'}\n`

    str += `是否代理合同：${is_proxy?'是 🔴' : '否 ✅ '}\n`

    str += `修改餘額：${owner_change_balance?'是 🔴' : '否 ✅ '}\n`
    str += `隱藏owner：${hidden_owner?'是 🔴' : '否 ✅ '}\n`
    str += `能自毀：${selfdestruct?'是 🔴' : '否 ✅ '}\n`
    str += `能買：${cannot_buy?'是 ✅' : '否  🔴'}\n`
    str += `全部賣出：${cannot_sell_all?'是 ✅' : '否  🔴'}\n`
    str += `修改稅收：${slippage_modifiable?'是 🔴' : '否  ✅'}\n`
    str += `暫停交易：${transfer_pausable?'是 🔴' : '否  ✅'}\n`
    str += `白名單：${is_blacklisted?'是 🔴' : '否  ✅'}\n`
    str += `黑名單：${is_whitelisted?'是 🔴' : '否  ✅'}\n`
    str += `空投骗局：${is_airdrop_scam?'是 🔴' : '否  ✅'}\n`
    // str += `所有者占比：${owner_percent}\n`
    // str += `LP占比：${lp_holder_count}\n`
    str += `創建者：${creator_address}\n`
    // console.log(str)
     return str;
    }

}catch(e){
    console.log(e)
    return "";
    
}
}
}
}

module.exports = new PancakeBot();