import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import json5 from 'json5';

import * as logger from './logger.mjs';

export interface Config extends Config.Log {
	botToken: string;
	activeGroupMap: Config.ActiveGroup[];
	publicGroupToActiveGroupMap:
	Map<number, Config.GroupConfig.PublicGroupWithIdConfig | Config.GroupConfig.CompleteGroupWithIdConfig>;
	privateGroupToActiveGroupMap:
	Map<number, Config.GroupConfig.PrivateGroupWithIdConfig | Config.GroupConfig.CompleteGroupWithIdConfig>;
}
// eslint-disable-next-line @typescript-eslint/no-namespace
export declare namespace Config {
	// eslint-disable-next-line @typescript-eslint/no-namespace
	namespace GroupConfig {
		interface PublicGroupConfig {
			welcomeOnJoinPublicGroup: boolean;
			welcomeOnJoinPublicGroupMessage: string;
		}
		interface PrivateGroupConfig {
			privateGroup: number;
			welcomeOnJoinPrivateGroup: boolean;
			welcomeOnJoinPrivateGroupMessage: string;
			notifyJoinRequest: boolean;
			notifyJoinRequestMessage: string;
			notifyJoinRequestWithApproveButton: boolean;
			notifyJoinRequestApproveButtonText: string;
			notifyJoinRequestDeclineButtonText: string;
			inviteLinkExpiredTime: number | false;
		}
		interface CompleteGroupConfig extends PublicGroupConfig, PrivateGroupConfig {
			autoAcceptJoinRequestWhenPublicGroupMember: boolean;
		}

		interface PublicGroupWithIdConfig extends PublicGroupConfig {
			publicGroup: number;
		}
		interface PrivateGroupWithIdConfig extends PrivateGroupConfig {
			privateGroup: number;
		}
		interface CompleteGroupWithIdConfig extends
			PublicGroupWithIdConfig,
			PrivateGroupWithIdConfig,
			CompleteGroupConfig
		{}
	}
	interface Log {
		logLevel: logger.LogLevel;
		logFile?: string;
	}

	// eslint-disable-next-line @typescript-eslint/no-namespace
	namespace Input {
		type InputActiveGroup =
			| Partial<GroupConfig.PublicGroupWithIdConfig>
			| Partial<GroupConfig.PublicGroupWithIdConfig>
			| Partial<GroupConfig.CompleteGroupWithIdConfig>;

		interface InputConfig extends Partial<GroupConfig.CompleteGroupConfig>, Partial<Log> {
			botToken: string;
			activeGroupMap: InputActiveGroup[];
		}
	}

	type ActiveGroup =
		| GroupConfig.PublicGroupConfig
		| GroupConfig.PublicGroupConfig
		| GroupConfig.CompleteGroupConfig;
}

type SettingKey = Exclude<keyof Config.GroupConfig.CompleteGroupConfig, 'publicGroup' | 'privateGroup'>;

const defaultSettingValue: {
	[key in SettingKey]: Config.GroupConfig.CompleteGroupConfig[key];
} = {
	welcomeOnJoinPublicGroup: false,
	welcomeOnJoinPublicGroupMessage: '您好，{mention} [<code>{id}</code>]，歡迎加入本群！',
	welcomeOnJoinPrivateGroup: false,
	welcomeOnJoinPrivateGroupMessage: '您好，{mention} [<code>{id}</code>]，歡迎加入本群！',
	notifyJoinRequest: false,
	notifyJoinRequestMessage: '{mention} [<code>{id}</code>] 已申請加入本群。',
	notifyJoinRequestWithApproveButton: false,
	notifyJoinRequestApproveButtonText: '允許',
	notifyJoinRequestDeclineButtonText: '拒絕',
	inviteLinkExpiredTime: false,
	autoAcceptJoinRequestWhenPublicGroupMember: false
};
const settingKeys = Reflect.ownKeys(defaultSettingValue) as SettingKey[];

export const projectRoot = path.join(fileURLToPath(import.meta.url), '..', '..');

async function validConfig(config: unknown): Promise<void> {
	if (!config || typeof config !== 'object') {
		throw new Error('Invalid config: ' + String(config));
	}
	if (!(config as Config.Input.InputConfig).botToken || typeof (config as Config.Input.InputConfig).botToken !== 'string') {
		throw new Error('Invalid config.botToken (must be string).');
	}
	if (!Array.isArray((config as Config.Input.InputConfig).activeGroupMap)) {
		throw new Error('Invalid config.activeGroupMap (must be array).');
	}
	(config as Config.Input.InputConfig).activeGroupMap.forEach((item, index) => {
		if ('publicGroup' in item && typeof item.publicGroup !== 'number') {
			throw new Error('Invalid config.activeGroupMap[' + String(index) + '] (publicGroup must be a number)');
		}
		if ('privateGroup' in item && typeof item.privateGroup !== 'number') {
			throw new Error('Invalid config.activeGroupMap[' + String(index) + '] (privateGroup must be a number)');
		}
		if (!('publicGroup' in item) && !('privateGroup' in item)) {
			throw new Error('Invalid config.activeGroupMap[' + String(index) + '] (publicGroup and privateGroup are both lost)');
		}
	});
	let logFile = (config as Config.Input.InputConfig).logFile;
	if (logFile) {
		delete (config as Config.Input.InputConfig).logFile;
		if (!path.isAbsolute(logFile)) {
			logFile = path.join(projectRoot, logFile);
		}
		await fs.promises.access(logFile, fs.constants.R_OK | fs.constants.W_OK);
		(config as Config.Input.InputConfig).logFile = logFile;
	}
}

function transInputConfig(input: Config.Input.InputConfig): Config {
	const result: Config = {
		botToken: input.botToken,
		activeGroupMap: [],
		publicGroupToActiveGroupMap: new Map(),
		privateGroupToActiveGroupMap: new Map(),
		logLevel: input.logLevel && logger.logLevels.includes(input.logLevel) ? input.logLevel : 'info'
	};

	for (const map of input.activeGroupMap) {
		const item: Config.Input.InputActiveGroup = Object.assign({}, map);
		for (const key of settingKeys) {
			// @ts-expect-error TS2322
			item[key] ??= input[key] ?? defaultSettingValue[key];
		}
		result.activeGroupMap.push(item as Config.ActiveGroup);
		if ('publicGroup' in item && item.publicGroup) {
			result.publicGroupToActiveGroupMap.set(item.publicGroup, item as Config.GroupConfig.PublicGroupWithIdConfig);
		}
		if ('privateGroup' in item && item.privateGroup) {
			result.privateGroupToActiveGroupMap.set(item.privateGroup, item as Config.GroupConfig.PrivateGroupWithIdConfig);
		}
	}

	return result;
}

async function getConfig(): Promise<Config> {
	return transInputConfig(await (async () => {
		let configPath: string;
		let isJSON5 = false;
		try {
			configPath = path.join(projectRoot, 'config.json5');
			await fs.promises.access(configPath, fs.constants.R_OK);
			isJSON5 = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				configPath = path.join(projectRoot, 'config.json');
				await fs.promises.access(configPath, fs.constants.R_OK);
			} else {
				throw error;
			}
		}
		const config = (isJSON5 ? json5.parse : JSON.parse)(
			await fs.promises.readFile(configPath, {
				encoding: 'utf-8'
			})
		) as Config.Input.InputConfig;
		await validConfig(config);

		return config;
	})());
}

export const config = await getConfig();

logger.onConfigFetched(config);
