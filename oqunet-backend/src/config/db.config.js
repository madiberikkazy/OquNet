module.exports = {
  HOST: "localhost",
  USER: "madiberikkazy004", // сенің user
  PASSWORD: "",              // пароль жоқ болса бос қалдыру
  DB: "oqunet",
  dialect: "postgres",
  pool: { max: 5, min: 0, acquire: 30000, idle: 10000 }
};