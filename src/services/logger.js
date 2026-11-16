const pino = require('pino');
const nodeEnv = process.env.NODE_ENV || 'development';

const logger = pino(
  nodeEnv === 'development'
    ? { level: 'debug', transport: { target: 'pino-pretty', options: { colorize: true } } }
    : { level: 'info' }
);

module.exports = logger;
