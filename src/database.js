var mysql      = require('mysql');

let connection = mysql.createConnection({
  host     : process.env.host,
  user     : process.env.user,
  password : process.env.password,
  database : process.env.database
});

module.exports = {
    query:async (sql)=>{
       await connection.query(sql);
    }
}