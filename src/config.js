require('dotenv').config();

module.exports = {
  BSC_RPC: process.env.BSC_RPC,
  BSC_V2_FACTORY: process.env.BSC_V2_FACTORY,
  BSC_V3_FACTORY: process.env.BSC_V3_FACTORY,
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  bot_chain:process.env.bot_chain
};
