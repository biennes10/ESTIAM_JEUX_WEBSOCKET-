// config/database.js
import 'dotenv/config'; // Si vous utilisez dotenv pour les variables d'environnement
import mysql from 'mysql2/promise';

const dbConfig = {
  host: process.env.DB_HOST || 'db', // 'db' est le nom du service Docker
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'root',
  database: process.env.DB_NAME || 'multiplayer',
  port: process.env.DB_PORT || 3306,
};

const pool = mysql.createPool(dbConfig);

export default pool;