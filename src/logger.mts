import log4js from 'log4js';

import { type Config } from './config.mjs';

export const logLevels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = typeof logLevels[number];

export function onConfigFetched(config: Config) {
	const log4jsConfig: log4js.Configuration = {
		appenders: {
			out: {
				type: 'stdout'
			}
		},
		categories: {
			default: {
				appenders: [],
				level: process.env.DEBUG ? 'all' : config.logLevel
			}
		}
	};
	if (config.logFile) {
		const appenderName = 'logToFile';
		log4jsConfig.appenders[appenderName] = {
			type: 'file',
			filename: config.logLevel,
			maxLogSize: 4 * 1024 * 1024,
			keepFileExt: true
		} as log4js.FileAppender;
		log4jsConfig.categories.default.appenders.push(appenderName);
	}
	const pm2 = process.env.PM2_APP_INSTANCE ?? process.env.NODE_APP_INSTANCE;
	if (pm2) {
		log4jsConfig.pm2 = true;
		log4jsConfig.pm2InstanceVar = pm2;
	}
	log4js.configure(log4jsConfig);
}
