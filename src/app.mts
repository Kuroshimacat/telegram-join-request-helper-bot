import log4js from 'log4js';
import format from 'string-format';

import type { Composer, Context, Filter } from 'grammy';
import type * as TT from '@grammyjs/types';

import { bot } from './bot.mjs';
import { config } from './config.mjs';
import { getGroupInviteLink, invalidInviteLink } from './data.mjs';
import type { LogLevel } from './logger.mjs';

const logger = log4js.getLogger('app');

function escapeHtml(value: string) {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function transformTGData<T, K extends keyof T, P extends string>(object: T, prefix: P, copyKeys: readonly K[]) {
	const result: Record<string, string> = {};
	for (const key of copyKeys) {
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
		result[prefix + '_' + (key as string)] = object[key] !== undefined ? escapeHtml(String(object[key])) : 'null';
	}
	return result;
}

type TAllPossibleChat = Partial<TT.Chat.AbstractChat & TT.Chat.UserNameChat & TT.Chat.TitleChat & {
	type: TT.Chat['type'];
}>;

const getFormatArgs = {
	default(): Record<string, string> {
		return {
			timestamp: new Date().toISOString()
		};
	},
	user(user: TT.User, prefix = 'u'): Record<string, string> {
		const fullname = escapeHtml(user.first_name + ' ' + (user.last_name ?? '')).trim();
		return {
			...transformTGData(user, prefix, [
				'id',
				'first_name',
				'last_name',
				'language_code'
			]),
			u_fullname: fullname,
			u_username: user.username ? '@' + user.username : 'null',
			u_mention: `<a href="tg://user?id=${user.id}">${fullname}</a>`
		};
	},
	chat(chat: TT.Chat, prefix = 'c'): Record<string, string> {
		if (chat.type === 'private') {
			return this.user(Object.assign({}, chat, {
				is_bot: false
			}) as TT.User, prefix);
		}
		return {
			...transformTGData(chat as TAllPossibleChat, prefix, [
				'id',
				'title'
			]),
			c_username: 'username' in chat && chat.username ? '@' + chat.username : 'null'
		};
	}
};

const threadIdMap: Record<string, number> = {};
function createLogThread(threadName: string) {
	threadIdMap[threadName] ??= 0;
	const id = ++threadIdMap[threadName];
	return {
		log(method: LogLevel, template: string, ...args: unknown[]) {
			template = '[%s:%d] ' + template;
			logger[method](
				template,
				threadName, id,
				...args
			);
		}
	};
}

bot.use(async function (ctx: Context, next: () => Promise<void>) {
	logger.trace(ctx);
	await next();
});

bot.on('message:new_chat_members', async function (ctx) {
	const thread = createLogThread('newChatMembers');
	if (
		ctx.message.new_chat_members.length === 1 &&
		ctx.message.from.id === ctx.message.new_chat_members[0].id
	) {
		thread.log(
			'debug',
			'%d joined group %d.',
			ctx.from.id,
			ctx.chat.id
		);
	} else {
		thread.log(
			'debug',
			'%d invited %s to group %d, ignored.',
			ctx.from.id,
			ctx.message.new_chat_members.map(u => u.id).join(', '),
			ctx.chat.id
		);
		return;
	}
	if (config.publicGroupToActiveGroupMap.has(ctx.chat.id)) {
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		const group = config.publicGroupToActiveGroupMap.get(ctx.chat.id)!;
		if (group.welcomeOnJoinPublicGroup) {
			let inviteLink = 'privateGroup' in group ? await getGroupInviteLink(group.privateGroup) : null;
			inviteLink = inviteLink ? 'https://t.me/+' + inviteLink : 'null';
			thread.log(
				'debug',
				'[public] Send welcome message to chat %d user %d (inviteLink: %s).',
				ctx.from.id,
				ctx.chat.id,
				inviteLink
			);
			await bot.api.sendMessage(
				ctx.chat.id,
				format(
					group.welcomeOnJoinPublicGroupMessage,
					{
						...getFormatArgs.default(),
						...getFormatArgs.chat(ctx.chat),
						...getFormatArgs.user(ctx.from),
						invite_link: inviteLink
					}
				),
				{
					parse_mode: 'HTML'
				}
			);
		}
	} else if (config.privateGroupToActiveGroupMap.has(ctx.chat.id)) {
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		const group = config.privateGroupToActiveGroupMap.get(ctx.chat.id)!;
		if (group.welcomeOnJoinPrivateGroup) {
			thread.log(
				'debug',
				'[private] Send welcome message to chat %d user %d.',
				ctx.from.id,
				ctx.chat.id
			);
			await bot.api.sendMessage(
				ctx.chat.id,
				format(
					group.welcomeOnJoinPrivateGroupMessage,
					{
						...getFormatArgs.default(),
						...getFormatArgs.chat(ctx.chat),
						...getFormatArgs.user(ctx.from)
					}
				),
				{
					parse_mode: 'HTML'
				}
			);
		}
	}
});

bot.on('chat_join_request', async function (ctx, next) {
	if (config.privateGroupToActiveGroupMap.has(ctx.chat.id)) {
		await next();
	}
}, async function (ctx) {
	const thread = createLogThread('chatJoinRequest');
	thread.log(
		'debug',
		'%d request to join group %d.',
		ctx.from.id,
		ctx.chat.id
	);
	// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
	const group = config.privateGroupToActiveGroupMap.get(ctx.chat.id)!;
	if (group.notifyJoinRequest) {
		if (group.notifyJoinRequestWithApproveButton) {
			thread.log(
				'debug',
				'Send notify message with approve button.'
			);
			await bot.api.sendMessage(
				ctx.chat.id,
				format(
					group.notifyJoinRequestMessage,
					{
						...getFormatArgs.default(),
						...getFormatArgs.user(ctx.from)
					}
				),
				{
					parse_mode: 'HTML',
					reply_markup: {
						inline_keyboard: [
							[
								{
									text: group.notifyJoinRequestApproveButtonText,
									callback_data: `jr:approve:${ctx.chat.id}:${ctx.chat.id}`
								},
								{
									text: group.notifyJoinRequestDeclineButtonText,
									callback_data: `jr:decline:${ctx.chat.id}:${ctx.chat.id}`
								}
							]
						]
					}
				}
			);
		} else {
			thread.log(
				'debug',
				'Send notify message without approve button.'
			);
			await bot.api.sendMessage(
				ctx.chat.id,
				format(
					group.notifyJoinRequestMessage,
					{
						...getFormatArgs.default(),
						...getFormatArgs.user(ctx.from)
					}
				),
				{
					parse_mode: 'HTML'
				}
			);
		}
	}

	if (
		'publicGroup' in group && group.publicGroup &&
		group.autoAcceptJoinRequestWhenPublicGroupMember
	) {
		thread.log(
			'trace',
			'Try to auto approve user.'
		);
		const member = await bot.api.getChatMember(
			group.publicGroup,
			ctx.from.id
		);
		thread.log(
			'trace',
			'Get public group member:',
			member
		);
		if (
			member.status !== 'kicked' &&
			member.status !== 'left' &&
			(member.status !== 'restricted' || member.can_send_messages)
		) {
			thread.log(
				'info',
				'Approve user %d join group %d.',
				ctx.from.id,
				ctx.chat.id
			);
			await ctx.approveChatJoinRequest(ctx.from.id);
		}
	}
});

type CallbackQueryContext = Filter<Context, 'callback_query:data'>;

const cbCallbacks: {
	pattern: RegExp;
	filter(ctx: CallbackQueryContext): boolean | Promise<boolean>;
	execute: (((ctx: CallbackQueryContext) => unknown | Promise<unknown>) | Composer<CallbackQueryContext>);
}[] = [
	{
		pattern: /^jr:(approve|decline):(-?\d+):(\d+)$/,
		filter(ctx) {
			return !!(ctx.callbackQuery.message && config.privateGroupToActiveGroupMap.has(ctx.callbackQuery.message.chat.id));
		},
		async execute(ctx) {
			const thread = createLogThread('callbackQuery:jr');
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			const message = ctx.callbackQuery.message!;
			const [, type, group, user] = this.pattern.exec(ctx.callbackQuery.data) ?? [];
			if (!type || message.chat.id !== +group) {
				thread.log(
					'error',
					'Fetch unknown callback query: %s',
					ctx.callbackQuery.data
				);
				return ctx.answerCallbackQuery('Unknown query reach.');
			}
			thread.log(
				'debug',
				'Get query %s (type: %s, group: %s, user: %s) from user %s',
				ctx.callbackQuery.data,
				type,
				group,
				user,
				ctx.from.id
			);
			let isApprove = false;
			try {
				const member = await bot.api.getChatMember(group, +user);
				isApprove = member.status !== 'left' && member.status !== 'kicked';
				thread.log(
					'trace',
					'Get private group member (isApprove=%s):',
					isApprove,
					member
				);
			} catch (error) {
				thread.log(
					'trace',
					'Get private group member fail, may member hasn\'t joined group:',
					error
				);
			}
			if (!isApprove) {
				const admin = await bot.api.getChatMember(group, ctx.callbackQuery.from.id);
				if (
					admin.status === 'creator' ||
					(admin.status === 'administrator' && admin.can_invite_users)
				) {
					thread.log(
						'info',
						'"%s" to join group.',
						type
					);
					try {
						if (type === 'decline') {
							await bot.api.declineChatJoinRequest(group, +user);
							await ctx.answerCallbackQuery('已允許' + user + '加入本群。');
						} else {
							await bot.api.approveChatJoinRequest(group, +user);
							await ctx.answerCallbackQuery('已允許' + user + '加入本群。');
						}
					} catch (error) {
						await ctx.answerCallbackQuery('自動通過貌似出了點問題。');
						thread.log(
							'error',
							'%s',
							error
						);
					}
				} else {
					await ctx.answerCallbackQuery('按鈕僅限管理員使用。');
				}
			}
			return bot.api.editMessageReplyMarkup(message.chat.id, message.message_id);
		}
	}
];

bot.on('callback_query', function (ctx) {
	if (ctx.callbackQuery.data) {
		for (const cb of cbCallbacks) {
			if (cb.pattern.exec(ctx.callbackQuery.data) && cb.filter(ctx as CallbackQueryContext)) {
				return typeof cb.execute === 'function'
					? cb.execute(ctx as CallbackQueryContext)
					// eslint-disable-next-line @typescript-eslint/no-empty-function
					: cb.execute.middleware()(ctx as CallbackQueryContext, async () => {});
			}
		}
	}
	return ctx.answerCallbackQuery('Unknown query reach.');
});

bot
	.chatType(['group', 'supergroup'])
	.on('message:text')
	.command('revokeCurrentLink', async function (ctx, next) {
		if (config.privateGroupToActiveGroupMap.has(ctx.chat.id)) {
			await next();
		}
	}, async function (ctx) {
		const thread = createLogThread('command:revokeCurrentLink');
		thread.log(
			'debug',
			'Get command %s from user %d chat %d',
			ctx.message.text,
			ctx.from.id,
			ctx.chat.id
		);
		const admin = await bot.api.getChatMember(ctx.message.chat.id, ctx.message.from.id);
		thread.log(
			'trace',
			'Get member:',
			admin
		);
		if (
			admin.status === 'creator' ||
			(admin.status === 'administrator' && admin.can_invite_users)
		) {
			thread.log(
				'debug',
				'Get command %s from user %d chat %d',
				ctx.message.text,
				ctx.from.id,
				ctx.chat.id
			);
			const [revokeResult, link] = await invalidInviteLink(ctx.message.chat.id, true);
			thread.log(
				'debug',
				'revoke result: ',
				{ revokeResult, link }
			);
			if (!link) {
				return ctx.reply('沒有連結可以撤銷。');
			} else if (revokeResult) {
				return ctx.reply('連結撤銷成功。');
			} else {
				return ctx.reply('連結撤銷失敗，可能是早已被其他管理員撤銷並且刪除了。請自行複查連結： ' + link);
			}
		}
		return ctx.reply('命令僅限管理員使用。');
	});

bot.catch((error) => logger.error(error));

await bot.start({
	allowed_updates: [
		'chat_join_request',
		'message'
	]
});
