import * as vscode from 'vscode';
import * as oicq from 'oicq';
import { refreshContacts } from "./explorer";
import { getConfig } from "./config";
import { client, ctx, genContactId, parseContactId } from "./global";

export interface WebViewPostData {
    command: keyof oicq.Client,
    params: any[],
    echo: string,
}

vscode.commands.registerCommand("oicq.c2c.open", openChatView);
vscode.commands.registerCommand("oicq.group.open", openChatView);

const webviewMap: Map<string, vscode.WebviewPanel> = new Map;

const availableThemes = [
    "default"
];

function getHtml(id: string, webview: vscode.Webview) {
    let css: string, js: string;
    const config = getConfig();
    if (config.theme_css && config.theme_js) {
        if (config.theme_css.startsWith("http")) {
            css = config.theme_css;
        } else {
            css = webview.asWebviewUri(vscode.Uri.file(config.theme_css)).toString();
        }
        if (config.theme_js.startsWith("http")) {
            js = config.theme_js;
        } else {
            js = webview.asWebviewUri(vscode.Uri.file(config.theme_js)).toString();
        }
    } else {
        let theme = "default";
        if (availableThemes.includes(String(config.theme))) {
            theme = String(config.theme);
        }
        css = webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "assets", theme + "-theme", "style.css")).toString();
        js = webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "assets", theme + "-theme", "app.js")).toString();
    }
    const { self, type, uin } = parseContactId(id);
    const path = webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "assets")).toString();
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" type="text/css" href="${css}" />
</head>
<body>
    <env self_id="${self}" nickname="${client.nickname}" c2c="${type === "u" ? 1 : 0}" target_id="${uin}" temp="0" path="${path}">
    <script src="${js}"></script>
</body>
</html>`;
}

function openChatView(id: string) {

    const { type, uin } = parseContactId(id);
    let label: string;
    if (type === "u") {
        label = String(client.fl.get(uin)?.nickname);
    } else {
        label = String(client.gl.get(uin)?.group_name);
    }

    if (webviewMap.has(id)) {
        return webviewMap.get(id)?.reveal();
    }
    const webview = vscode.window.createWebviewPanel("chat", label, -1, {
        enableScripts: true,
        enableCommandUris: true,
        retainContextWhenHidden: true
    });
    webviewMap.set(id, webview);
    webview.webview.html = getHtml(id, webview.webview);
    webview.reveal();
    webview.onDidDispose(() => {
        webviewMap.delete(id);
    });
    webview.onDidChangeViewState((event) => {
        if (event.webviewPanel.visible) {
            refreshContacts(id, false);
        }
    });
    webview.webview.onDidReceiveMessage(async (data: WebViewPostData) => {
        try {
            if (data.command === "getChatHistory" && data.params?.[0] === "") {
                let buf: Buffer;
                if (type === "g") {
                    buf = Buffer.alloc(21);
                } else {
                    buf = Buffer.alloc(17);
                }
                buf.writeUInt32BE(uin, 0); 
                data.params[0] = buf.toString("base64");
            }
            const fn = client[data.command];
            if (typeof fn === "function") {
                //@ts-ignore
                let ret: any = fn.apply(client, Array.isArray(data.params) ? data.params : []);
                if (ret instanceof Promise) {
                    ret = await ret;
                }
                if (ret.data instanceof Map) {
                    ret.data = [...ret.data.values()];
                }
                ret.echo = data.echo;
                webview.webview.postMessage(ret);
            }
        } catch { }
    });
}

function postC2CEvent(data: oicq.FriendNoticeEventData | oicq.PrivateMessageEventData) {
    const id = genContactId("u", data.user_id);
    webviewMap.get(id)?.webview.postMessage(data);
}

function postGroupEvent(data: oicq.GroupNoticeEventData | oicq.GroupMessageEventData) {
    const id = genContactId("g", data.group_id);
    webviewMap.get(id)?.webview.postMessage(data);
}

export function bind() {
    client.on("message.group", function (data) {
        const id = genContactId("g", data.group_id);
        if (webviewMap.get(id)?.visible) {
            return;
        }
        refreshContacts(id, true);
    });

    client.on("message.private", function (data) {
        const id = genContactId("u", data.user_id);
        if (webviewMap.get(id)?.visible) {
            return;
        }
        refreshContacts(id, true);
    });

    client.on("message.group", postGroupEvent);
    client.on("message.private", postC2CEvent);

    client.on("notice.group", postGroupEvent);
    client.on("notice.friend.recall", postC2CEvent);
    client.on("notice.friend.poke", postC2CEvent);
}
