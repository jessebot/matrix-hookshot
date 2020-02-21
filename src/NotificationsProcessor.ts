import { MessageSenderClient } from "./MatrixSender";
import { IStorageProvider } from "./Stores/StorageProvider";
import { UserNotificationsEvent, UserNotification } from "./UserNotificationWatcher";
import { LogWrapper } from "./LogWrapper";
import { AdminRoom } from "./AdminRoom";
import markdown from "markdown-it";
import { Octokit } from "@octokit/rest";

const log = new LogWrapper("GithubBridge");
const md = new markdown();

export interface IssueDiff {
    state: null|string;
    assignee: null|Octokit.IssuesGetResponseAssignee;
    title: null|string;
}

export class NotificationProcessor {

    private static formatNotification(notif: UserNotification, diff: IssueDiff|null, newComment: boolean) {
        let plain = `${this.getEmojiForNotifType(notif)} [${notif.subject.title}](${notif.subject.url_data.html_url})`;
        const issueNumber = notif.subject.url_data?.number;
        if (notif.repository) {
            plain += ` for **[${notif.repository.full_name}](${notif.repository.html_url})`;
            if (issueNumber) {
                plain += `#${issueNumber}`;
            }
        }
        if (diff) {
            if (diff.state) {
                const state = diff.state[0].toUpperCase() + diff.state.slice(1).toLowerCase();
                plain += `\n State changed to: ${state}`;
            }
            if (diff.title) {
                plain += `\n Title changed to: ${diff.title}`;
            }
            if (diff.assignee) {
                plain += `\n Assigned to: ${diff.assignee.login}`;
            }
        }
        if (newComment) {
            const comment = notif.subject.latest_comment_url_data as Octokit.IssuesGetCommentResponse;
            plain += `\n**[${comment.user.login}](${comment.user.html_url})**: ${comment.body}`;
        }
        return {
            plain,
            html: md.render(plain),
        };
    }

    private static getEmojiForNotifType(notif: UserNotification): string {
        switch (notif.subject.type) {
            case "Issue":
                return "📝";
            case "PullRequest":
                return "⤵";
            default:
                return "🔔";
        }
    }

    constructor(private storage: IStorageProvider, private matrixSender: MessageSenderClient) {

    }

    public async onUserEvents(msg: UserNotificationsEvent, adminRoom: AdminRoom) {
        log.info(`Got new events for ${adminRoom.userId}`);
        for (const event of msg.events) {
            try {
                await this.handleUserNotification(msg.roomId, event);
            } catch (ex) {
                log.warn("Failed to handle event:", ex);
            }
            if (event.subject.url_data?.number) {
                await this.storage.setGithubIssue(
                    event.repository.full_name,
                    event.subject.url_data.number,
                    event.subject.url_data,
                    msg.roomId,
                );
            }
            if (event.subject.latest_comment_url) {
                await this.storage.setLastNotifCommentUrl(
                    event.repository.full_name,
                    event.subject.url_data.number,
                    event.subject.latest_comment_url,
                    msg.roomId,
                );
            }
        }
        try {
            await adminRoom.setNotifSince(msg.lastReadTs);
        } catch (ex) {
            log.error("Failed to update stream position for notifications:", ex);
        }
    }

    private diffIssueChanges(curr: Octokit.IssuesGetResponse, prev: Octokit.IssuesGetResponse): IssueDiff {
        const diff: IssueDiff = {
            state: curr.state === prev.state ? null : curr.state,
            assignee: curr.assignee?.id === prev.assignee?.id ? null : curr.assignee,
            title: curr.title === prev.title ? null : curr.title,
        };
        return diff;
    }

    private async handleUserNotification(roomId: string, notif: UserNotification) {
        log.info("New notification event:", notif);
        const issueNumber = notif.subject.url_data?.number;
        let diff = null;
        if (issueNumber) {
            const prevIssue: Octokit.IssuesGetResponse|null = await this.storage.getGithubIssue(
                notif.repository.full_name, issueNumber, roomId);
            if (prevIssue) {
                diff = this.diffIssueChanges(notif.subject.url_data, prevIssue);
            }
        }
        const newComment = !!notif.subject.latest_comment_url && notif.subject.latest_comment_url !==
            (await this.storage.getLastNotifCommentUrl(notif.repository.full_name, issueNumber, roomId));
        const formatted = NotificationProcessor.formatNotification(notif, diff, newComment);
        await this.matrixSender.sendMatrixMessage(roomId, {
            msgtype: "m.text",
            body: formatted.plain,
            formatted_body: formatted.html,
            format: "org.matrix.custom.html",
        });
    }
}