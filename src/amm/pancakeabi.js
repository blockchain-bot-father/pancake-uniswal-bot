const IRouterV2_ABI = [
  "function addLiquidity(address tokenA, address tokenB, uint amountADesired, uint amountBDesired, uint amountAMin, uint amountBMin, address to, uint deadline) external returns (uint amountA, uint amountB, uint liquidity)",
  "function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) payable returns (uint amountToken, uint amountETH, uint liquidity)"
];
// Minimal ABIs (你可以用更完整的 ABI 文件)
const IPancakeV3Factory_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address)"
];
const IUniswapV3Pool_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)"
];
const INonfungiblePositionManager_ABI = [
  "function mint(tuple(address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  "function increaseLiquidity(uint256 tokenId, uint128 amount0Desired, uint128 amount1Desired, uint128 amount0Min, uint128 amount1Min, uint256 deadline) external returns (uint128 liquidity, uint256 amount0, uint256 amount1)"
];

const IWBNB_ABI = [
  // deposit()
  "function deposit() payable",
  // withdraw(uint256 wad)
  "function withdraw(uint256 wad)",
  // approve(address spender, uint256 amount) returns (bool)
  "function approve(address spender, uint256 amount) returns (bool)",
  // transfer(address to, uint256 value) returns (bool)
  "function transfer(address to, uint256 value) returns (bool)"
];
module.exports = { IWBNB_ABI,IRouterV2_ABI,IPancakeV3Factory_ABI,IUniswapV3Pool_ABI,INonfungiblePositionManager_ABI };
