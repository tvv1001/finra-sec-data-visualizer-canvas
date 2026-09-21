import fs from 'node:fs';
import path from 'node:path';
import winston from 'winston';

const logDir = path.join(process.cwd(), 'data', 'logs');

// Serverless platforms (Vercel, etc.) mount the deployment bundle read-only,
// so creating data/logs and writing app.log there throws ENOENT/EROFS. Fall
// back to console-only logging whenever the directory can't be created.
let fileLoggingAvailable = false;
try {
	fs.mkdirSync(logDir, { recursive: true });
	fileLoggingAvailable = true;
} catch {
	fileLoggingAvailable = false;
}

const transports: winston.transport[] = [new winston.transports.Console()];
if (fileLoggingAvailable) {
	transports.push(
		new winston.transports.File({
			filename: path.join(logDir, 'app.log'),
			level: 'info',
			maxsize: 10 * 1024 * 1024,
			maxFiles: 5,
			tailable: true,
		}),
	);
}

export const logger = winston.createLogger({
	level: process.env.LOG_LEVEL || 'info',
	format: winston.format.combine(
		winston.format.timestamp(),
		winston.format.json(),
	),
	transports,
});
