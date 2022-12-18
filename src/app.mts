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
	user(user: TT.User, prefix = 'user'): Record<string, string> {
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
	chat(chat: TT.Chat, prefix = 'group'): Record<string, string> {
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
		ctx.from.id === ctx.message.new_chat_members[0].id
	) {
		thread.log(
			'info',
			'%d joined group %d.',
			ctx.from.id,
			ctx.chat.id
		);
	} else {
		thread.log(
			'info',
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
			const privateGroup = 'privateGroup' in group ? await bot.api.getChat(group.privateGroup) : null;
			thread.log(
				'info',
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
						...(privateGroup ? getFormatArgs.chat(privateGroup, 'private_group') : {}),
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
				'info',
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
		'info',
		'%d request to join group %d.',
		ctx.from.id,
		ctx.chat.id
	);
	// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
	const group = config.privateGroupToActiveGroupMap.get(ctx.chat.id)!;
	// 先檢查是否能被自動通過
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
			// 已經被自動通過就不需要再發送通知了
			return ctx.approveChatJoinRequest(ctx.from.id);
		}
	}

	// 再檢查是否發送通知
	if (group.notifyJoinRequest) {
		if (group.notifyJoinRequestWithApproveButton) {
			thread.log(
				'info',
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
									text: '允許',
									callback_data: `jr:approve:${ctx.chat.id}:${ctx.chat.id}`
								},
								{
									text: '拒絕',
									callback_data: `jr:decline:${ctx.chat.id}:${ctx.chat.id}`
								}
							]
						]
					}
				}
			);
		} else {
			thread.log(
				'info',
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
				'info',
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
	.command('revokeCurrentLink', async function (ctx, next) {
		if (config.privateGroupToActiveGroupMap.has(ctx.chat.id)) {
			await next();
		}
	}, async function (ctx) {
		const thread = createLogThread('command:revokeCurrentLink');
		thread.log(
			'info',
			'Get command %s from user %d chat %d',
			ctx.message.text,
			ctx.from.id,
			ctx.chat.id
		);
		const admin = await bot.api.getChatMember(ctx.chat.id, ctx.from.id);
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
			const [revokeResult, link] = await invalidInviteLink(ctx.chat.id, true);
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

if (config.enableSuExitMode) {
	bot
		.chatType(['group', 'supergroup'])
		.command('su', async function (ctx, next) {
			if (config.privateGroupToActiveGroupMap.has(ctx.chat.id)) {
				await next();
			}
		}, async function (ctx) {
			const thread = createLogThread('command:su');
			thread.log(
				'info',
				'Get command %s from user %d chat %d',
				ctx.message.text,
				ctx.from.id,
				ctx.chat.id
			);
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			const group = config.privateGroupToActiveGroupMap.get(ctx.chat.id)!;
			if (!('publicGroup' in group) || !group.publicGroupAdminBecomePrivateGroupAdminEnable) {
				return ctx.reply('群組未啟用相關功能。');
			}
			const privateMember = await bot.api.getChatMember(ctx.chat.id, ctx.from.id);
			thread.log(
				'trace',
				'Get private group member:',
				privateMember
			);
			if (
				privateMember.status === 'creator' ||
				privateMember.status === 'administrator'
			) {
				return ctx.reply('我無法讓您成為管理員。');
			}
			const botStat = await bot.api.getChatMember(ctx.chat.id, ctx.me.id);
			thread.log(
				'trace',
				'Get bot:',
				botStat
			);
			if (botStat.status !== 'administrator' || !botStat.can_promote_members) {
				return ctx.reply('我無法於此處讓您成為管理員。');
			}

			const publicMember = await bot.api.getChatMember(
				group.publicGroup,
				ctx.from.id
			);
			thread.log(
				'trace',
				'Get public group:',
				publicMember
			);
			if (
				publicMember.status !== 'creator' &&
				publicMember.status !== 'administrator'
			) {
				return ctx.reply('您沒有進行此操作的權限。');
			}

			const permKeys = [
				'can_delete_messages',
				'can_invite_users',
				'can_pin_messages',
				'can_restrict_members',
				'can_manage_video_chats'
			] as const;
			const perms: Partial<Record<typeof permKeys[number] | 'can_manage_chat', true>> = {
				can_manage_chat: true
			};
			for (const permKey of permKeys) {
				if (botStat[permKey]) {
					perms[permKey] = true;
				}
			}

			try {
				await bot.api.promoteChatMember(
					ctx.chat.id,
					ctx.from.id,
					perms
				);
				thread.log(
					'info',
					'Promote user %d in %d success.',
					ctx.from.id,
					ctx.chat.id
				);

				if (group.publicGroupAdminBecomePrivateGroupAdminCustomTitle) {
					try {
						await bot.api.setChatAdministratorCustomTitle(
							ctx.chat.id,
							ctx.from.id,
							group.publicGroupAdminBecomePrivateGroupAdminCustomTitle
						);
						thread.log(
							'info',
							'Set user %d in %d custom title: %s.',
							ctx.from.id,
							ctx.chat.id,
							group.publicGroupAdminBecomePrivateGroupAdminCustomTitle
						);
					} catch (error) {
						thread.log(
							'error',
							'Fail to set user %d in %d: %s',
							error
						);
					}
				}
				return ctx.reply('您已成為管理員，請按 /exit 退出。', {
					reply_to_message_id: ctx.message.message_id,
					allow_sending_without_reply: true
				});
			} catch (error) {
				thread.log(
					'error',
					'Fail to promote user %d in %d: %s',
					error
				);
				return ctx.reply('抱歉，由於技術故障，未能完成授權。', {
					reply_to_message_id: ctx.message.message_id,
					allow_sending_without_reply: true
				});
			}
		});

	bot
		.chatType(['group', 'supergroup'])
		.command('exit', async function (ctx, next) {
			if (config.privateGroupToActiveGroupMap.has(ctx.chat.id)) {
				await next();
			}
		}, async function (ctx) {
			const thread = createLogThread('command:exit');
			thread.log(
				'info',
				'Get command %s from user %d chat %d',
				ctx.message.text,
				ctx.from.id,
				ctx.chat.id
			);
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			const group = config.privateGroupToActiveGroupMap.get(ctx.chat.id)!;
			if (!('publicGroup' in group) || !group.publicGroupAdminBecomePrivateGroupAdminEnable) {
				return ctx.reply('群組未啟用相關功能。');
			}
			const member = await bot.api.getChatMember(ctx.chat.id, ctx.from.id);
			thread.log(
				'trace',
				'Get member:',
				member
			);
			if (
				member.status === 'creator' ||
				(member.status === 'administrator' && member.can_be_edited)
			) {
				return ctx.reply('那是不可能的。');
			} else if (member.status !== 'administrator') {
				return ctx.reply('您又不是管理員。');
			}
			try {
				await bot.api.promoteChatMember(
					ctx.chat.id,
					ctx.from.id,
					{
						can_manage_chat: false
					}
				);
				thread.log(
					'info',
					'Demote user %d in %d success.',
					ctx.from.id,
					ctx.chat.id
				);

				return ctx.reply('已成功更改您的權限。', {
					reply_to_message_id: ctx.message.message_id,
					allow_sending_without_reply: true
				});
			} catch (error) {
				thread.log(
					'error',
					'Fail to demote user %d in %d: %s',
					error
				);
				return ctx.reply('抱歉，更改您的權限失敗了。', {
					reply_to_message_id: ctx.message.message_id,
					allow_sending_without_reply: true
				});
			}
		});
}

bot.catch((error) => logger.error(error));

await bot.start({
	allowed_updates: [
		'chat_join_request',
		'message'
	]
});
