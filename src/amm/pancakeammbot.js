require('dotenv').config();
const { ethers } = require("ethers");
const { ERC20_ABI } = require("./ERC20.js");
const { IWBNB_ABI,IRouterV2_ABI,IUniswapV3Pool_ABI,IPancakeV3Factory_ABI,INonfungiblePositionManager_ABI } = require("./pancakeabi.js");
class PancakeAMM{

    constructor(){
        this.config={
            rpc:process.env.BSC_RPC,
            v2_router: process.env.ROUTER_V2_ADDRESS,//v2 路由合約
            BSC_PRIVATEKEY:process.env.BSC_PRIVATEKEY,//幣安鏈地址私鑰
            V3_FACTORY:process.env.BSC_V3_FACTORY,//v3工廠合約
            NONFUNGIBLE_POSITION_MANAGER:process.env.BSC_NONFUNGIBLE_POSITION_MANAGER
        }

        if (!config.BSC_PRIVATEKEY) {
            console.error("请检查 .env 配置是否完整！");
            process.exit(1);
        }
       
    }

    //構建錢包
    async getWallet(){

        const provider = new ethers.providers.JsonRpcProvider(this.config.rpc);
        const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
        return wallet;
    }

    //非原生代幣BNB添加v2底池
    async addLiquidityV2Token(token0,token1,token0Amount,token1Amount) {

        const wallet = await this.getWallet();

        const amountADesired = ethers.utils.parseUnits(token0Amount, 18); // 例如 10 token0
        const amountBDesired = ethers.utils.parseUnits(token1Amount, 18); // 例如 20 token1

        const amountAMin = amountADesired.mul(95).div(100); // 滑点 5%
        const amountBMin = amountBDesired.mul(95).div(100);

        const deadline = Math.floor(Date.now() / 1000) + 60 * 10; // 10 分钟有效期
        const to = await wallet.getAddress();

        const tokenAContract = new ethers.Contract(token0, ERC20_ABI, wallet);
        const tokenBContract = new ethers.Contract(token1, ERC20_ABI, wallet);

        // 授权 router 转移 token0 & token1
        const router = new ethers.Contract(this.config.v2_router, IRouterV2_ABI, wallet);

        console.log("Approving tokens...");
        const tx1 = await tokenAContract.approve(this.config.v2_router, amountADesired);
        await tx1.wait();
        const tx2 = await tokenBContract.approve(this.config.v2_router, amountBDesired);
        await tx2.wait();

        console.log("Calling addLiquidity...");
        const tx = await router.addLiquidity(
            token0,
            token1,
            amountADesired,
            amountBDesired,
            amountAMin,
            amountBMin,
            to,
            deadline,
            { gasLimit: 800000 }
        );
        const receipt = await tx.wait();
        console.log("addLiquidity receipt:", receipt.transactionHash);
    }

    //原生代幣BNB添加v2底池
    async addLiquidityV2BNB(token0,token0Amount,BNBAmount) {
       
         const wallet = await this.getWallet();
         const router = new ethers.Contract(this.config.v2_router, IRouterV2_ABI, signer);
        // 授权 Router 使用 Token
        const tokenContract = new ethers.Contract(token0, ERC20_ABI, wallet);
        await (await tokenContract.approve(this.config.v2_router, token0Amount)).wait();

        const amountTokenMin = token0Amount.mul(95).div(100); // 滑点 5%
        const amountETHMin = BNBAmount.mul(95).div(100);
        const deadline = Math.floor(Date.now() / 1000) + 60 * 10;

        console.log("添加流动性...");
        const tx = await router.addLiquidityETH(
            token0,
            token0Amount,
            amountTokenMin,
            amountETHMin,
            await wallet.getAddress(),
            deadline,
            { value: BNBAmount, gasLimit: 800000 }
        );
        await tx.wait();

        console.log("✅ 添加成功:", tx.hash);
    }


    //v3 token添加流動性
    async addLiquidityV3Token(token0,token1,token0Amount,token1Amount) {
 
        const wallet = await this.getWallet();
        const fee = 3000; // 例如 0.3% = 3000，Pancake fee tier
        const amount0Desired = ethers.utils.parseUnits(token0Amount, 18);
        const amount1Desired = ethers.utils.parseUnits(token1Amount, 18);
        const amount0Min = amount0Desired.mul(98).div(100);
        const amount1Min = amount1Desired.mul(98).div(100);
        const recipient = await wallet.getAddress();
        const deadline = Math.floor(Date.now() / 1000) + 60 * 10;

        const factory = new ethers.Contract(this.config.V3_FACTORY, IPancakeV3Factory_ABI, wallet);
        const poolAddress = await factory.getPool(token0, token1, fee);
        if (poolAddress === ethers.constants.AddressZero) {
            throw new Error("Pool not exists for this token pair + fee");
        }
        console.log("Pool:", poolAddress);

        const pool = new ethers.Contract(poolAddress, IUniswapV3Pool_ABI, wallet);
        const slot0 = await pool.slot0();
        const currentTick = slot0.tick;
        console.log("Current tick:", currentTick.toString());

        // 读取 tickSpacing（不同 fee 有不同 spacing）
        const tickSpacing = await pool.tickSpacing();
        console.log("tickSpacing:", tickSpacing.toString());

        // 示例策略：以 currentTick 为中心，范围为 ± tickSpacing*10
        const tickLower = currentTick - tickSpacing * 10;
        const tickUpper = currentTick + tickSpacing * 10;

        console.log("tickLower:", tickLower.toString(), "tickUpper:", tickUpper.toString());

        // 授权给 NonfungiblePositionManager
        const token0Contract = new ethers.Contract(token0, ERC20_ABI, wallet);
        const token1Contract = new ethers.Contract(token1, ERC20_ABI, wallet);

        console.log("Approving tokens to position manager...");
        await (await token0Contract.approve(this.config.NONFUNGIBLE_POSITION_MANAGER, amount0Desired)).wait();
        await (await token1Contract.approve(this.config.NONFUNGIBLE_POSITION_MANAGER, amount1Desired)).wait();

        const positionManager = new ethers.Contract(this.config.NONFUNGIBLE_POSITION_MANAGER, INonfungiblePositionManager_ABI, wallet);

        // 构造参数并 mint
        const params = {
            token0,
            token1,
            fee,
            tickLower: Math.floor(tickLower),
            tickUpper: Math.floor(tickUpper),
            amount0Desired,
            amount1Desired,
            amount0Min,
            amount1Min,
            recipient,
            deadline
        };

        console.log("Minting position...");
        const tx = await positionManager.mint(params, { gasLimit: 1000000 });
        const receipt = await tx.wait();
        console.log("mint tx hash:", receipt.transactionHash);
    }

    //bnb轉WBNB
    async BNBtoWbnb(amount){
        const WBNB = process.env.WBNB; // 主网 WBNB

        const wbnb = new ethers.Contract(WBNB, WBNB_ABI, signer);
        await (await wbnb.deposit({ value: ethers.utils.parseEther(amount) })).wait();
    }


    //WBNB轉bnb
    async WbnbtoBNB(amount){
        const WBNB = process.env.WBNB; // 主网 WBNB

        const wbnb = new ethers.Contract(WBNB, WBNB_ABI, signer);
        await (await wbnb.withdraw(ethers.utils.parseEther(amount))).wait();
    }

    //v3 BNB添加流動性
    async addLiquidityV3BNB(token0,token1,token0Amount,token1Amount) {
        
        this.BNBtoWbnb(token1Amount);
        this.addLiquidityV3Token(token0,token1,token0Amount,token1Amount)

    }

    //
   

    }

module.exports = new PancakeAMM();