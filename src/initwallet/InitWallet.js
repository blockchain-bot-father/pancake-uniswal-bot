const ethers = require("ethers");
const db = require('../database');
const fs = require('fs');

class InitWallet {

    constructor() {
        this.config = {
            num: 300, //生成數量
        };
        
    }
// 生成正则匹配表达式，靚號生成
 CreateRegex() {
    const regexList = [];
    var regex = new RegExp(`[0]{1,20}$`);
    regexList.push(regex);
    regex = new RegExp(`[1]{1,20}$`);
    regexList.push(regex);
    regex = new RegExp(`[2]{1,20}$`);
    regexList.push(regex);
    regex = new RegExp(`[3]{1,20}$`);
    regexList.push(regex);
    regex = new RegExp(`[4]{1,20}$`);
    regexList.push(regex);
    regex = new RegExp(`[5]{1,20}$`);
    regexList.push(regex);
    regex = new RegExp(`[6]{1,20}$`);
    regexList.push(regex);
    regex = new RegExp(`[7]{1,20}$`);
    regexList.push(regex);
    regex = new RegExp(`[8]{1,20}$`);
    regexList.push(regex); 
    regex = new RegExp(`[9]{1,20}$`);
    regexList.push(regex);
    regex = new RegExp(`[a]{1,20}$`);
    regexList.push(regex);
    regex = new RegExp(`[b]{1,20}$`);
    regexList.push(regex);
    regex = new RegExp(`[c]{1,20}$`);
    regexList.push(regex);
    regex = new RegExp(`[d]{1,20}$`);
    regexList.push(regex);
    regex = new RegExp(`[e]{1,20}$`);
    regexList.push(regex);
    regex = new RegExp(`[f]{1,20}$`);
    regexList.push(regex);
        

    return regexList;
}



create = async () => {
    // 生成正则表达式
    let regexL = this.CreateRegex()

    let count = 0;
    while (count<this.config.num) {
            let wallet = await ethers.Wallet.createRandom();
            const index = regexL.findIndex(regex => regex.test(wallet.address));
            
            // 移除匹配的正则表达式，打開注釋即可生成尾號相連的地址
            //if (index !== -1|) {
            
                try{
                    
                    const data = `${wallet.address}:${wallet.privateKey}`
                    console.log(data)
                    
                    const sql = `INSERT  INTO bot(wallet,privatekey) VALUES ('${wallet.address}','${wallet.privateKey}');\n\t`
                    
                    //寫文件或寫數據庫
                    //await db.query(sql);
                    await fs.appendFileSync('sql.txt', sql, err => {
                    if (err) {
                        console.error(err);
                    }
                    // file written successfully
                    });
                    count++;
                }catch(e){
                    console.log(e) 
                }
            //}
        
    }
    }

}
module.exports = new InitWallet();
