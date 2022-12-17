import fs from 'node:fs';
import path from 'node:path';

import log4js from 'log4js';

import { config, projectRoot } from './config.mjs';
import { bot } from './bot.mjs';

const logger = {
	main: log4js.getLogger('data:main'),
	invite: {
		create: log4js.getLogger('data:invite:create'),
		revoke: log4js.getLogger('data:invite:expired')
	}
};

interface GroupData {
	inviteLink?: GroupData.InviteLink;
}
// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace GroupData {
	interface InviteLink {
		link: string;
		expired: string | null;
	}
}

type GroupDataStore = Record<number, GroupData>;

let groupDataStore: GroupDataStore;

let handler: fs.promises.FileHandle;

async function init() {
	handler = await fs.promises.open(path.join(projectRoot, 'data.json'), 'w+');
	const content = await handler.readFile({
		encoding: 'utf-8'
	});
	if (content !== '') {
		let json: unknown;
		try {
			json = JSON.parse(content);
			if (Array.isArray(json)) {
				groupDataStore = json;
				return;
			}
			throw new Error('Validate data.json fail, value must be an array.');
		} catch (error) {
			const timestamp = String(Date.now()).slice(0, -3);
			logger.main.error(
				'Fail to read previous data, old data would be moved to data.json.%s.old: %s',
				timestamp,
				error
			);
			await handler.close();
			await fs.promises.rename(
				path.join(projectRoot, 'data.json'),
				path.join(projectRoot, 'data.json.' + timestamp + '.old')
			);
			handler = await fs.promises.open(path.join(projectRoot, 'data.json'), 'wx+');
		}
	}
	groupDataStore = [];
	await save();
}

async function save() {
	try {
		await handler.writeFile(JSON.stringify(groupDataStore), {
			encoding: 'utf-8'
		});
	} catch (error) {
		logger.main.error(
			'Fail to save data: %s',
			error
		);
	}
}

await init();

function groupShouldSetInviteLink(groupId: number): boolean {
	const group = config.privateGroupToActiveGroupMap.get(groupId);
	return !!(group && 'welcomeOnJoinPublicGroup' in group && group.welcomeOnJoinPublicGroup);
}

function getInviteLinkExpiredTime(groupId: number): number | undefined {
	const group = config.privateGroupToActiveGroupMap.get(groupId);
	return group?.inviteLinkExpiredTime ? Date.now() + group.inviteLinkExpiredTime * 1000 : undefined;
}

export async function invalidInviteLink(groupId: number, force = false): Promise<[result: boolean, preLink: string | null]> {
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
	const link = groupDataStore[groupId]?.inviteLink;
	if (!link) {
		return [true, null];
	}
	if (link.expired && new Date(link.expired).getTime() < Date.now()) {
		delete groupDataStore[groupId].inviteLink;
		logger.invite.revoke.info(
			'Group %d: Link %s expired at %s.',
			groupId,
			link.link,
			link.expired
		);
		await save();
		return [true, link.link];
	} else if (force) {
		delete groupDataStore[groupId].inviteLink;
		try {
			await bot.api.revokeChatInviteLink(groupId, link.link);
			logger.invite.revoke.info(
				'Group %d: Link %s has been force revoke.',
				groupId,
				link.link,
				link.expired
			);
			await save();
			return [true, link.link];
		} catch (error) {
			logger.invite.revoke.error(
				'Group %d: Link %s has been force revoke but fail: %s',
				groupId,
				link.link,
				link.expired,
				error
			);
			await save();
			return [false, link.link];
		}
	}
	return [false, null];
}

export async function getGroupInviteLink(groupId: number): Promise<string | null> {
	if (!groupShouldSetInviteLink(groupId)) {
		return null;
	}
	groupDataStore[groupId] ??= {};
	await invalidInviteLink(groupId);
	try {
		groupDataStore[groupId].inviteLink ??= await (async () => {
			const link = await bot.api.createChatInviteLink(groupId, {
				creates_join_request: true,
				expire_date: getInviteLinkExpiredTime(groupId)
			});
			logger.invite.create.info(
				'Group %d: Link %s has been created (expired: %s).',
				groupId,
				link.invite_link.slice('https://t.me/+'.length),
				link.expire_date ? new Date(link.expire_date * 1000).toISOString() : 'never'
			);
			return {
				link: link.invite_link.slice('https://t.me/+'.length),
				expired: link.expire_date ? new Date(link.expire_date * 1000).toISOString() : null
			};
		})();
		await save();
		return groupDataStore[groupId].inviteLink?.link ?? null;
	} catch (error) {
		logger.invite.create.error(
			'Group %d: Fail to create invite link: %s',
			groupId,
			error
		);
		return null;
	}
}
