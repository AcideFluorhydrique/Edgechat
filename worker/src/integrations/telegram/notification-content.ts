import type { TelegramDatabase } from "../../data/telegram-direct.ts";
import { decryptMessageContent } from "../../encryption.js";
import { activeUserSql } from "../../user-status.js";
import { TELEGRAM_CHAT_LIST, telegramDmButton } from "./direct-messages.ts";

interface NotificationMessage {
  id: number;
  channel_id: number;
  room_name: string;
  content: string;
  sender_id: number | null;
  sender_kind: string;
  source: string;
  external_sender_id: string;
  sender_name: string;
  attachment_name: string | null;
  attachment_key: string | null;
}

function shorten(text: string, limit: number) {
  return text.length <= limit ? text : `${text.slice(0, limit - 14).replace(/[\uD800-\uDBFF]$/, "")}…（更多请在站内查看）`;
}
function label(text: string) {
  return String(text || "EdgeChat").replace(/[\r\n]/g, " ").slice(0, 80);
}

export async function buildTelegramNotification(env: { DB: TelegramDatabase }, {
  ids, userId, chatId, kind,
}: { ids: number[]; userId: number; chatId: string; kind: string }) {
  // 出队时读取原消息并重新核对成员/绑定/偏好，队列不复制明文，退群或删除后也不会泄露旧正文。
  const { results } = await env.DB.prepare(`SELECT o.id, o.channel_id, o.room_name,
    m.content, m.sender_id, m.sender_kind, m.source, m.external_sender_id,
    COALESCE(NULLIF(m.external_sender_name, ''), sender.display_name, sender.username, '用户') AS sender_name,
    m.attachment_name, m.attachment_key
    FROM telegram_notification_outbox o
    JOIN messages m ON m.id = o.message_id AND m.channel_id = o.channel_id AND m.deleted_at IS NULL
    JOIN channels c ON c.id = o.channel_id AND c.deleted_at IS NULL
    JOIN channel_members me ON me.channel_id = c.id AND me.user_id = o.user_id
    JOIN telegram_notification_users n ON n.user_id = o.user_id
    JOIN users viewer ON viewer.id = o.user_id
    LEFT JOIN users sender ON sender.id = m.sender_id
    WHERE o.id IN (${ids.map(() => "?").join(",")}) AND o.user_id = ?
      AND n.telegram_chat_id = ? AND viewer.deleted_at IS NULL AND ${activeUserSql("viewer")}
      AND CASE WHEN o.kind = 'dm' THEN n.dm_enabled ELSE n.mention_enabled END = 1
      AND ((o.kind = 'dm' AND c.kind = 'dm') OR (o.kind = 'mention' AND c.kind IN ('public', 'private')))
      AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE c.kind = 'dm'
        AND ((b.blocker_id = o.user_id AND b.blocked_id = m.sender_id)
          OR (b.blocker_id = m.sender_id AND b.blocked_id = o.user_id)))
    ORDER BY o.id`).bind(...ids, userId, chatId).all<NotificationMessage>();
  if (!results.length) return null;
  const blocks = [];
  const rooms = new Map<number, { id: number; name: string }>();
  const budget = Math.floor(3500 / results.length);
  for (const row of results) {
    const content = await decryptMessageContent(env, row.content, {
      channelId: row.channel_id, senderId: row.sender_id ?? 0,
      senderContext: row.sender_kind === "external" ? `${row.source}:${row.external_sender_id}` : "",
    });
    const title = kind === "dm" ? label(row.sender_name) : `${label(row.room_name)} · ${label(row.sender_name)}`;
    const attachment = row.attachment_key ? `\n[附件：${label(row.attachment_name || "文件")}，请在站内查看]` : "";
    blocks.push(shorten(`${title}\n${content}${attachment}`, budget));
    if (kind === "dm") rooms.set(row.channel_id, { id: row.channel_id, name: label(row.sender_name) });
  }
  return {
    text: `${kind === "dm" ? "EdgeChat 私信" : "EdgeChat 群聊提及"}\n\n${blocks.join("\n\n")}`,
    replyMarkup: {
      keyboard: [...rooms.values()].map(room => [telegramDmButton(room)])
        .concat([[{ text: TELEGRAM_CHAT_LIST }]]),
      resize_keyboard: true,
    },
  };
}
