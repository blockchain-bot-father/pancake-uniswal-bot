const PancakeBot = require('./bot/pancakebot.js');
const UniswapBot = require('./bot/uniswapbot.js');
const config = require('./config');
const bot_chain = config.bot_chain

console.log(bot_chain)
if(bot_chain=="BSC"){
    PancakeBot.process();
}
else if(bot_chain=="ETH"){
    UniswapBot.process();
}
else if(bot_chain=="BSC_ETH"){
     PancakeBot.process();
     UniswapBot.process();
}