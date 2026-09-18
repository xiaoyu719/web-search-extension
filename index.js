const MODULE_ID = "web-search-extension";
const PROMPT_KEY = "web-search-extension";
const TEMPLATE_FOLDER = "third-party/web-search-extension";
const IN_CHAT = 1;
const SYSTEM_ROLE = 0;
const MAX_PROMPT_CHARS = 2800;
const FETCH_TIMEOUT_MS = 8000;

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    autoSearch: false,
    triggerMode: "smart",
    keywords: "搜一下,搜索,查一下,最新,联网,websearch,搜",
    forceKeywords: "同人,原作,官方设定,真人真事,不要编,别瞎编,不能原创,不可原创,按真实,以现实为准,按官方,查准,符合原作",
    skipKeywords: "原创,架空,OC,纯属虚构,编一个,随便编",
    allowAiRequest: true,
    useQiuwen: true,
    useMoegirl: true,
    useWikipediaZh: false,
    useWikipediaEn: false,
    useDuckDuckGo: false,
    customSearchUrl: "",
    tavilyApiKey: "",
    sourceMode: "auto",
    writeToWorldbook: true,
    worldbookName: "",
    skipIfInWorldbook: true,
    maxItems: 6,
});

const searchCache = { chatId: "", query: "", text: "" };
let initialized = false;
let lastWorldbookWriteStatus = "";
let slashRegistered = false;
let uiRoot = null;
let uiCleanup = null;

function tryGetContext() {
    try {
        return globalThis.SillyTavern?.getContext?.() ?? null;
    } catch {
        return null;
    }
}

function getContext() {
    const context = tryGetContext();
    if (!context) throw new Error("[" + MODULE_ID + "] SillyTavern context is unavailable");
    return context;
}

function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function detectHost() {
    return globalThis.__TAURITAVERN__ ? "TauriTavern" : "SillyTavern";
}

function initializeSettings() {
    const context = tryGetContext();
    if (!context?.extensionSettings) return null;
    const current = context.extensionSettings[MODULE_ID];
    if (!isObject(current)) {
        context.extensionSettings[MODULE_ID] = { ...DEFAULT_SETTINGS };
    } else {
        const hadTriggerMode = Object.prototype.hasOwnProperty.call(current, "triggerMode");
        const hadQiuwen = Object.prototype.hasOwnProperty.call(current, "useQiuwen");
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
            if (!Object.prototype.hasOwnProperty.call(current, key)) current[key] = DEFAULT_SETTINGS[key];
        }
        if (!hadTriggerMode) current.triggerMode = current.autoSearch ? "always" : "smart";
        if (!hadQiuwen) {
            current.useQiuwen = true;
            current.useMoegirl = true;
            current.useWikipediaZh = false;
            current.useWikipediaEn = false;
            current.useDuckDuckGo = false;
        }
        if (!Object.prototype.hasOwnProperty.call(current, "writeToWorldbook")) {
            current.writeToWorldbook = current.writeToDatabase !== false;
        }
        if (!Object.prototype.hasOwnProperty.call(current, "worldbookName")) {
            current.worldbookName = "";
        }
    }
    context.saveSettingsDebounced?.();
    return context.extensionSettings[MODULE_ID];
}

function getSettings() {
    const context = getContext();
    if (!isObject(context.extensionSettings[MODULE_ID])) initializeSettings();
    return context.extensionSettings[MODULE_ID];
}

function parseKeywords(raw) {
    return String(raw || "")
        .split(/[,，;；\n]+/)
        .map((item) => item.trim())
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);
}

function lastUserText(chat) {
    if (!Array.isArray(chat)) return "";
    for (let index = chat.length - 1; index >= 0; index -= 1) {
        const message = chat[index];
        if (message?.is_user) return String(message.mes || "").trim();
    }
    return "";
}

function getTriggerMode(settings) {
    if (settings?.triggerMode === "keyword" || settings?.triggerMode === "always" || settings?.triggerMode === "smart") {
        return settings.triggerMode;
    }
    return settings?.autoSearch ? "always" : "smart";
}

function listMatches(text, raw) {
    const haystack = String(text || "");
    return parseKeywords(raw).some((keyword) => haystack.toLowerCase().includes(keyword.toLowerCase()));
}

function hasKeyword(text, settings) {
    return listMatches(text, settings?.keywords);
}

function lastAiText(chat) {
    if (!Array.isArray(chat)) return "";
    for (let index = chat.length - 1; index >= 0; index -= 1) {
        const message = chat[index];
        if (message && !message.is_user && !message.is_system) return String(message.mes || "").trim();
    }
    return "";
}

function extractAiSearchRequest(text) {
    const source = String(text || "");
    const match = source.match(/【需要检索[:：]\s*([^】]+)】/)
        || source.match(/【检索[:：]\s*([^】]+)】/)
        || source.match(/<!--\s*search[:：]\s*([^>]+)-->/i);
    return match ? match[1].trim() : "";
}

function looksLikeFanCanon(text) {
    return /(同人|原作|官方设定|官方剧情|真人真事|现实世界|二创|原型|正史|不要原创|不能原创|不可原创)/.test(String(text || ""));
}

function combinedKeywords(settings) {
    return parseKeywords(settings?.keywords).concat(parseKeywords(settings?.forceKeywords));
}

function looksLikeRoleplay(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return false;
    if (/^[\*＊].*[\*＊]$/.test(trimmed)) return true;
    if (/^(（|\().*action|narration/i.test(trimmed)) return true;
    if (/^(我|你)(轻轻|慢慢|默默|忽然|突然)?(走|看|听|笑|吻|抱|坐|躺|站|点头|摇头|开口|说道|回道)/.test(trimmed) && !/[？?]/.test(trimmed)) return true;
    return false;
}

function looksLikeChitChat(text) {
    return /^(嗯+|好的?|哦+|啊+|哈+|继续|下一条|谢谢|多谢|收到|在吗|你好|哈喽|hello|hi)\s*[。.!！]?$/i.test(String(text || "").trim());
}

function needsLiveInfo(text) {
    const trimmed = String(text || "").trim();
    if (trimmed.length < 2 || looksLikeChitChat(trimmed) || looksLikeRoleplay(trimmed)) return false;
    let score = 0;
    if (/[？?]/.test(trimmed) || /(吗|呢|么)$/.test(trimmed)) score += 2;
    if (/(今天|今日|昨天|今晚|本周|本月|本赛季|本轮|今年|目前|现在|实时|最新|刚刚|当前)/.test(trimmed)) score += 3;
    if (/(比分|积分榜|积分|赛程|对阵|转会|伤停|天气|新闻|排名|冠军|汇率|股价|几比几|世界杯|欧冠|欧联|亚冠|联赛|战报|首发)/.test(trimmed)) score += 3;
    if (/(是谁|是什么|什么时候|多少|在哪|怎么|如何|介绍|背景|资料|现状|近况)/.test(trimmed)) score += 2;
    if (/(19|20)\d{2}/.test(trimmed)) score += 1;
    if (trimmed.length <= 36 && !looksLikeChitChat(trimmed)) score += 1;
    return score >= 2;
}

function extractQuery(text, keywords, fallbackQuery) {
    if (fallbackQuery) return String(fallbackQuery).trim();
    let trimmed = String(text || "").trim();
    const commandMatch = trimmed.match(/^\/(?:websearch|联网搜索)\s+(.+)/i);
    if (commandMatch) return commandMatch[1].trim();
    for (const keyword of keywords) {
        const position = trimmed.toLowerCase().indexOf(keyword.toLowerCase());
        if (position >= 0) {
            const after = trimmed.slice(position + keyword.length).replace(/^[\s:：,，。.]+/, "");
            trimmed = (after || trimmed).trim();
            break;
        }
    }
    trimmed = trimmed.replace(/^(请问|麻烦你?|帮我|我想问一下|你知道|能不能告诉我|告诉我|查一下|搜一下|搜索一下|联网搜索一下)+[，,：:\s]*/g, "");
    const sentences = trimmed.split(/[。！!\n]+/).map((item) => item.trim()).filter(Boolean);
    const question = [...sentences].reverse().find((item) => /[？?吗呢]$/.test(item) || /(谁|什么|多少|哪|几|是否)/.test(item));
    const picked = question || (trimmed.length > 80 ? (sentences[sentences.length - 1] || trimmed) : trimmed);
    return picked.replace(/[？?！!。]+$/g, "").trim() || trimmed;
}

function shouldSearch(userText, settings, aiText) {
    if (!settings?.enabled) return false;
    const blob = String(userText || "") + "\n" + String(aiText || "");
    const trimmedUser = String(userText || "").trim();
    const aiQuery = settings.allowAiRequest !== false ? extractAiSearchRequest(aiText) : "";
    const forced = listMatches(blob, settings.forceKeywords) || looksLikeFanCanon(blob);
    const skipped = listMatches(blob, settings.skipKeywords);
    if (skipped && !forced && !aiQuery) return false;
    if (forced || aiQuery) return true;
    if (!trimmedUser && !aiQuery) return false;
    const mode = getTriggerMode(settings);
    if (mode === "always") return true;
    if (hasKeyword(trimmedUser, settings) || hasKeyword(aiText, settings)) return true;
    if (mode === "keyword") return false;
    return needsLiveInfo(trimmedUser);
}

function buildPrompt(searchText, settings, skippedOriginal) {
    if (skippedOriginal) {
        return "【检索纪律】用户明确要原创或架空，本轮不要强行套真实资料，按当前剧情推进。";
    }
    const rule = "【检索纪律】同人、原作、真人真事或已有官方设定，禁止用原创替代事实。下面若有检索摘要，必须先用摘要，再写正文。不要把检索过程写进故事。";
    return searchText ? (rule + "\n\n" + searchText) : rule;
}

function parsePreflight(raw) {
    const text = String(raw || "").replace(/```/g, "").trim();
    if (!text) return "";
    const hasSearch = /SEARCH\s*[:：]/i.test(text) || /检索\s*[:：]/.test(text);
    if (/NO_SEARCH/i.test(text) && !hasSearch) return "";
    const match = text.match(/SEARCH\s*[:：]\s*(.+)/i) || text.match(/检索\s*[:：]\s*(.+)/);
    if (match) return match[1].split(/[\n\r]/)[0].replace(/[。.\s]+$/, "").trim();
    const first = text.split(/[\n\r]/)[0].trim();
    if (first.length <= 40 && !/NO_SEARCH/i.test(first) && !/^【/.test(first)) return first;
    return "";
}

let preflightBusy = false;
let hostCallBusy = false;

async function preflightSearchQuery(userText) {
    if (preflightBusy) return "";
    const context = tryGetContext();
    if (typeof context?.generateQuietPrompt !== "function") return "";
    const quietPrompt = [
        "你现在只做检索官，绝对不要写故事正文、对白或描写。",
        "判断接下来这轮：如果是同人、原作、真人真事、官方设定或现实资料，不能用原创代替，就必须检索。",
        "若需要检索，只输出一行：SEARCH: 简短检索词",
        "若不需要检索，只输出：NO_SEARCH",
        "禁止解释。",
        "用户本轮：",
        String(userText || "").slice(0, 500),
    ].join("\n");
    preflightBusy = true;
    try {
        const raw = await context.generateQuietPrompt({
            quietPrompt,
            quietToLoud: false,
            skipWIAN: false,
            responseLength: 64,
            removeReasoning: true,
            trimToSentence: true,
        });
        return parsePreflight(raw);
    } catch (error) {
        console.warn("[" + MODULE_ID + "] preflight failed", error);
        return "";
    } finally {
        preflightBusy = false;
    }
}

function shouldPreflight(userText, settings, skippedOriginal, wantSearch, query) {
    if (settings.allowAiRequest === false || skippedOriginal) return false;
    if (looksLikeChitChat(userText)) return false;
    const mode = getTriggerMode(settings);
    if (mode === "always") return false;
    if (wantSearch && query && query.length <= 40 && query !== String(userText || "").trim()) return false;
    if (mode === "keyword") return looksLikeFanCanon(userText) || listMatches(userText, settings.forceKeywords);
    return String(userText || "").trim().length >= 4;
}

function clipLine(value, limit) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (text.length <= limit) return text;
    return text.slice(0, Math.max(0, limit - 1)) + "…";
}

function clipBlock(value, limit) {
    const text = String(value || "").trim();
    if (text.length <= limit) return text;
    return text.slice(0, Math.max(0, limit - 1)) + "…";
}

function withTimeout(ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return {
        signal: controller.signal,
        done() { clearTimeout(timer); },
    };
}

async function readJson(response) {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) return response.json();
    const text = await response.text();
    try { return JSON.parse(text); } catch { return { raw: text }; }
}


function clipExtract(text) {
    return clipLine(String(text || "").replace(/\s+/g, " ").trim(), 220);
}

async function searchMediaWiki(source, query, signal) {
    const api = "https://" + source.host + source.apiPath;
    const searchUrl = api + "?action=opensearch&search=" + encodeURIComponent(query) + "&limit=5&namespace=0&format=json&origin=*";
    const response = await fetch(searchUrl, { signal });
    if (!response.ok) throw new Error(source.label + " HTTP " + response.status);
    const data = await response.json();
    const titles = Array.isArray(data?.[1]) ? data[1] : [];
    const snippets = Array.isArray(data?.[2]) ? data[2] : [];
    const links = Array.isArray(data?.[3]) ? data[3] : [];
    const items = titles.map((title, index) => ({
        source: source.label,
        title: String(title || ""),
        snippet: clipExtract(snippets[index]),
        url: String(links[index] || ""),
    })).filter((item) => item.title);
    if (!items.length) throw new Error(source.label + " 无结果");

    const missing = items.filter((item) => !item.snippet).slice(0, 5);
    if (!missing.length) return items;

    const extractUrl = api + "?action=query&prop=extracts&exintro=1&explaintext=1&exchars=220&titles=" + encodeURIComponent(missing.map((item) => item.title).join("|")) + "&origin=*&format=json";
    const extractResponse = await fetch(extractUrl, { signal });
    if (!extractResponse.ok) return items;
    const extractData = await extractResponse.json();
    const pages = extractData?.query?.pages || {};
    const byTitle = {};
    for (const page of Object.values(pages)) {
        if (page?.title) byTitle[page.title] = clipExtract(page.extract);
    }
    for (const item of items) {
        if (!item.snippet && byTitle[item.title]) item.snippet = byTitle[item.title];
    }
    return items;
}

function searchWikipedia(lang, query, signal) {
    const zh = lang === "zh";
    return searchMediaWiki({
        host: zh ? "zh.wikipedia.org" : "en.wikipedia.org",
        apiPath: "/w/api.php",
        label: zh ? "维基百科中文" : "Wikipedia",
    }, query, signal);
}

function searchQiuwen(query, signal) {
    return searchMediaWiki({
        host: "www.qiuwenbaike.cn",
        apiPath: "/api.php",
        label: "求闻百科",
    }, query, signal);
}

function searchMoegirl(query, signal) {
    return searchMediaWiki({
        host: "zh.moegirl.org.cn",
        apiPath: "/api.php",
        label: "萌娘百科",
    }, query, signal);
}

function flattenRelated(topics, bucket) {
    if (!Array.isArray(topics)) return;
    for (const topic of topics) {
        if (topic?.Text) {
            bucket.push({
                source: "DuckDuckGo",
                title: String(topic.Text).split(" - ")[0] || "DuckDuckGo",
                snippet: String(topic.Text),
                url: String(topic.FirstURL || ""),
            });
        }
        if (Array.isArray(topic?.Topics)) flattenRelated(topic.Topics, bucket);
    }
}

async function searchDuckDuckGo(query, signal) {
    const url = "https://api.duckduckgo.com/?q=" + encodeURIComponent(query) + "&format=json&no_html=1&skip_disambig=1";
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error("DuckDuckGo HTTP " + response.status);
    const data = await readJson(response);
    const items = [];
    if (data?.AbstractText) {
        items.push({
            source: "DuckDuckGo",
            title: String(data.Heading || query),
            snippet: String(data.AbstractText),
            url: String(data.AbstractURL || ""),
        });
    }
    flattenRelated(data?.RelatedTopics, items);
    if (!items.length) throw new Error("DuckDuckGo 无即时答案，或浏览器/Tauri 跨域拦截");
    return items;
}

async function searchCustom(urlTemplate, query, signal) {
    const url = String(urlTemplate || "").split("{{query}}").join(encodeURIComponent(query));
    if (!/^https?:\/\//i.test(url)) throw new Error("自定义搜索地址无效");
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error("自定义搜索 HTTP " + response.status);
    const data = await readJson(response);
    if (Array.isArray(data?.results)) {
        return data.results.map((item) => ({
            source: "自定义搜索",
            title: String(item.title || item.name || query),
            snippet: String(item.content || item.snippet || item.description || ""),
            url: String(item.url || item.link || ""),
        }));
    }
    if (typeof data?.raw === "string") {
        return [{ source: "自定义搜索", title: query, snippet: clipLine(data.raw, 280), url }];
    }
    return [{ source: "自定义搜索", title: query, snippet: clipLine(JSON.stringify(data), 280), url }];
}

async function searchTavily(apiKey, query, signal) {
    const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey, query, max_results: 5 }),
        signal,
    });
    if (!response.ok) throw new Error("Tavily HTTP " + response.status);
    const data = await readJson(response);
    const results = Array.isArray(data?.results) ? data.results : [];
    if (!results.length) throw new Error("Tavily 无结果，或跨域被拦");
    return results.map((item) => ({
        source: "Tavily",
        title: String(item.title || query),
        snippet: String(item.content || ""),
        url: String(item.url || ""),
    }));
}

function formatResults(query, items, notes) {
    const lines = ["【联网搜索结果】", "查询：" + query];
    if (!items.length) {
        lines.push("没有拿到可用摘要。");
        if (notes.length) lines.push("说明：" + notes.join("；"));
        lines.push("检索失败时，请继续按已有剧情回答，不要编造实时新闻。");
        return lines.join("\n");
    }
    for (const item of items) {
        lines.push("- " + item.source + "｜" + item.title);
        if (item.snippet) lines.push("  " + clipLine(item.snippet, 180));
        if (item.url) lines.push("  " + item.url);
    }
    if (notes.length) lines.push("说明：" + notes.join("；"));
    lines.push("以上为检索摘要，仅供参考。若与角色卡或当前剧情冲突，以剧情为准，不要编造未出现的事实。");
    return clipBlock(lines.join("\n"), MAX_PROMPT_CHARS);
}


function getSourceMode(settings) {
    const mode = String(settings?.sourceMode || "auto");
    if (mode === "direct" || mode === "mainApi") return mode;
    return "auto";
}

function parseMainApiResults(query, raw) {
    const text = String(raw || "").replace(/```/g, "").trim();
    if (!text || /^NO_RESULT\b/i.test(text)) return [];
    const items = [];
    for (const line of text.split(/[\n\r]+/)) {
        const cleaned = line.replace(/^[-*]\s*/, "").trim();
        if (!cleaned || /NO_RESULT/i.test(cleaned)) continue;
        const parts = cleaned.split(/[?|]/).map((part) => part.trim()).filter(Boolean);
        if (parts.length >= 2) {
            items.push({
                source: "\u4e3bAPI",
                title: parts[0],
                snippet: clipLine(parts.slice(1).join(" "), 220),
                url: "",
            });
        }
        if (items.length >= 6) break;
    }
    if (!items.length) {
        items.push({
            source: "\u4e3bAPI",
            title: String(query || ""),
            snippet: clipLine(text, 280),
            url: "",
        });
    }
    return items.filter((item) => item.title || item.snippet);
}

async function raceTimeout(promise, ms) {
    let timer = 0;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("\u8d85\u65f6")), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function searchViaMainApi(query) {
    const context = tryGetContext();
    if (typeof context?.generateRaw !== "function" && typeof context?.generateQuietPrompt !== "function") {
        throw new Error("\u5f53\u524d\u9152\u9986\u6ca1\u6709\u4e3bAPI\u8c03\u7528\u53e3");
    }
    const systemPrompt = [
        "\u4f60\u53ea\u505a\u8d44\u6599\u5458\uff0c\u7edd\u5bf9\u4e0d\u8981\u5199\u6545\u4e8b\u3001\u5bf9\u767d\u6216\u63cf\u5199\u3002",
        "\u82e5\u5f53\u524d\u63a5\u53e3\u80fd\u4e0a\u7f51\uff0c\u5148\u6309\u516c\u5f00\u8d44\u6599\u56de\u7b54\uff1b\u82e5\u4e0d\u80fd\u4e0a\u7f51\uff0c\u53ea\u5199\u4f60\u786e\u5b9a\u7684\u516c\u5f00\u5e38\u8bc6\uff0c\u4e0d\u786e\u5b9a\u5c31\u5199\u4e0d\u786e\u5b9a\u3002",
        "\u7981\u6b62\u7f16\u9020\u5177\u4f53\u6bd4\u5206\u3001\u6392\u540d\u3001\u5f15\u8bed\u6216\u5b9e\u65f6\u65b0\u95fb\u3002",
        "\u6bcf\u6761\u4e00\u884c\uff1a\u6807\u9898\uff5c\u6458\u8981",
        "\u6ca1\u6709\u53ef\u7528\u4fe1\u606f\u53ea\u8f93\u51fa NO_RESULT",
    ].join("\n");
    const prompt = "\u68c0\u7d22\u8bcd\uff1a" + String(query || "").slice(0, 200);
    hostCallBusy = true;
    try {
        let raw = "";
        if (typeof context.generateRaw === "function") {
            raw = await raceTimeout(context.generateRaw({
                    prompt,
                    systemPrompt,
                    quietToLoud: false,
                    instructOverride: true,
                    responseLength: 360,
                    trimNames: true,
                }), 20000);
        } else {
            raw = await raceTimeout(context.generateQuietPrompt({
                    quietPrompt: systemPrompt + "\n" + prompt,
                    quietToLoud: false,
                    skipWIAN: true,
                    responseLength: 360,
                    removeReasoning: true,
                }), 20000);
        }
        const items = parseMainApiResults(query, raw);
        if (!items.length) throw new Error("\u4e3bAPI\u65e0\u53ef\u7528\u6458\u8981");
        return items;
    } finally {
        hostCallBusy = false;
    }
}

async function runSearch(query, settings) {
    const sourceMode = getSourceMode(settings);
    const jobs = [];
    if (sourceMode !== "mainApi") {
        if (settings.useQiuwen) jobs.push(["\u6c42\u95fb\u767e\u79d1", (signal) => searchQiuwen(query, signal)]);
        if (settings.useMoegirl) jobs.push(["\u840c\u5a18\u767e\u79d1", (signal) => searchMoegirl(query, signal)]);
        if (settings.useWikipediaZh) jobs.push(["\u7ef4\u57fa\u767e\u79d1\u4e2d\u6587", (signal) => searchWikipedia("zh", query, signal)]);
        if (settings.useWikipediaEn) jobs.push(["Wikipedia", (signal) => searchWikipedia("en", query, signal)]);
        if (settings.useDuckDuckGo) jobs.push(["DuckDuckGo", (signal) => searchDuckDuckGo(query, signal)]);
        if (String(settings.customSearchUrl || "").trim()) {
            jobs.push(["\u81ea\u5b9a\u4e49\u641c\u7d22", (signal) => searchCustom(settings.customSearchUrl, query, signal)]);
        }
        if (String(settings.tavilyApiKey || "").trim()) {
            jobs.push(["Tavily", (signal) => searchTavily(settings.tavilyApiKey, query, signal)]);
        }
    }

    const items = [];
    const notes = [];
    const maxItems = Math.max(1, Number(settings.maxItems) || 6);

    await Promise.all(jobs.map(async ([label, job]) => {
        const clock = withTimeout(FETCH_TIMEOUT_MS);
        try {
            const found = await job(clock.signal);
            for (const item of found) {
                if (items.length >= maxItems) break;
                items.push(item);
            }
        } catch (error) {
            const message = error?.name === "AbortError" ? "\u8d85\u65f6" : (error?.message || String(error));
            notes.push(label + "\u5931\u8d25\uff1a" + message);
        } finally {
            clock.done();
        }
    }));

    const needMainApi = sourceMode === "mainApi" || (sourceMode === "auto" && items.length === 0);
    if (needMainApi) {
        try {
            const found = await searchViaMainApi(query);
            for (const item of found) {
                if (items.length >= maxItems) break;
                items.push(item);
            }
            notes.push("\u4e3bAPI\u8d70\u4f60\u6b63\u5728\u7528\u7684\u804a\u5929\u63a5\u53e3\uff0c\u4e0d\u662f\u7f51\u9875\u6293\u53d6\u3002\u6a21\u578b\u82e5\u4e0d\u80fd\u4e0a\u7f51\uff0c\u5185\u5bb9\u53ef\u80fd\u4e0d\u662f\u5b9e\u65f6\u7f51\u9875\u8d44\u6599\u3002");
        } catch (error) {
            notes.push("\u4e3bAPI\u5931\u8d25\uff1a" + (error?.message || error));
        }
    }

    if (!jobs.length && sourceMode !== "mainApi") notes.push("\u672a\u542f\u7528\u4efb\u4f55\u641c\u7d22\u6e90");
    return formatResults(query, items, notes);
}



const WORLD_ENTRY_PREFIX = "[联网搜索]";

function listWorldInfoNames(context) {
    if (typeof context?.getWorldInfoNames === "function") {
        const names = context.getWorldInfoNames();
        if (Array.isArray(names)) return names.map((name) => String(name || "").trim()).filter(Boolean);
    }
    return [];
}

function characterPrimaryWorld(context) {
    const chid = context?.characterId;
    const characters = Array.isArray(context?.characters) ? context.characters : [];
    const character = characters[chid] ?? characters[Number(chid)] ?? null;
    return String(character?.data?.extensions?.world || "").trim();
}

function resolveWorldbookName(context, settings) {
    const names = listWorldInfoNames(context);
    const wanted = String(settings.worldbookName || "").trim();
    if (wanted) {
        const exact = names.find((name) => name === wanted);
        if (exact) return exact;
        const ignoreCase = names.find((name) => name.toLowerCase() === wanted.toLowerCase());
        if (ignoreCase) return ignoreCase;
        return wanted;
    }
    const primary = characterPrimaryWorld(context);
    if (primary) return primary;
    if (names.length) return names[0];
    return "";
}

function ownedSearchComment(query) {
    return WORLD_ENTRY_PREFIX + " " + String(query || "").trim();
}

function isOwnedSearchEntry(entry) {
    return Boolean(entry) && String(entry.comment || "").startsWith(WORLD_ENTRY_PREFIX);
}

function findOwnedSearchEntry(entries, query) {
    const wanted = ownedSearchComment(query);
    const list = Object.values(entries || {});
    return list.find((entry) => isOwnedSearchEntry(entry) && String(entry.comment || "") === wanted)
        || list.find((entry) => isOwnedSearchEntry(entry) && Array.isArray(entry.key) && entry.key.includes(query))
        || null;
}

function getFreeWorldEntryUid(data) {
    const entries = data?.entries;
    const used = new Set();
    if (entries && typeof entries === "object") {
        for (const key of Object.keys(entries)) {
            const uid = Number(key);
            if (Number.isInteger(uid)) used.add(uid);
        }
    }
    let uid = 0;
    while (used.has(uid)) uid += 1;
    return uid;
}

function buildWorldKeys(query) {
    const keys = [];
    const add = (value) => {
        const text = String(value || "").trim();
        if (!text || keys.includes(text) || keys.length >= 8) return;
        keys.push(text);
    };
    add(query);
    String(query || "").split(/[\s,，、/|]+/).forEach(add);
    return keys.length ? keys : [String(query || "搜索").trim()];
}

function createOwnedSearchEntry(data, query, content) {
    const uid = getFreeWorldEntryUid(data);
    const entry = {
        uid,
        key: buildWorldKeys(query),
        keysecondary: [],
        comment: ownedSearchComment(query),
        content,
        constant: false,
        vectorized: false,
        selective: true,
        selectiveLogic: 0,
        addMemo: true,
        order: 100,
        position: 0,
        disable: false,
        ignoreBudget: false,
        excludeRecursion: true,
        preventRecursion: true,
        matchPersonaDescription: false,
        matchCharacterDescription: false,
        matchCharacterPersonality: false,
        matchCharacterDepthPrompt: false,
        matchScenario: false,
        matchCreatorNotes: false,
        delayUntilRecursion: 0,
        probability: 100,
        useProbability: true,
        depth: 4,
        outletName: "",
        group: "",
        groupOverride: false,
        groupWeight: 100,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: null,
        automationId: "",
        role: 0,
        sticky: null,
        cooldown: null,
        delay: null,
        triggers: [],
    };
    data.entries[uid] = entry;
    return entry;
}


function wantsFreshSearch(userText, settings) {
    const text = String(userText || "").trim();
    if (!text) return false;
    if (/^\/(?:websearch|联网搜索)\b/i.test(text)) return true;
    if (hasKeyword(text, settings)) return true;
    return /(今天|今日|昨天|今晚|本周|本月|本赛季|本轮|今年|目前|现在|实时|最新|刚刚|当前|比分|新闻)/.test(text);
}

function isUsefulWorldKey(value) {
    const key = String(value || "").trim();
    if (key.length < 2) return false;
    if (/^[a-z0-9_\-]+$/i.test(key) && key.length < 3) return false;
    return true;
}

function entryCoversText(entry, userText, query) {
    if (!entry || entry.disable) return false;
    const hay = (String(userText || "") + "\n" + String(query || "")).toLowerCase();
    if (!hay.trim()) return false;
    const comment = String(entry.comment || "");
    if (comment.startsWith(WORLD_ENTRY_PREFIX)) {
        const ownedQuery = comment.slice(WORLD_ENTRY_PREFIX.length).trim();
        if (ownedQuery && hay.includes(ownedQuery.toLowerCase())) return true;
    }
    const keys = Array.isArray(entry.key) ? entry.key : [];
    return keys.some((key) => isUsefulWorldKey(key) && hay.includes(String(key).toLowerCase()));
}

function coveringEntryInData(data, userText, query) {
    const entries = data?.entries && typeof data.entries === "object" ? Object.values(data.entries) : [];
    return entries.find((entry) => entryCoversText(entry, userText, query)) || null;
}

async function findWorldbookCoverage(userText, query, settings) {
    if (settings.skipIfInWorldbook === false) return null;
    const context = tryGetContext();
    if (typeof context?.loadWorldInfo !== "function") return null;
    const names = [];
    const add = (name) => {
        const text = String(name || "").trim();
        if (text && !names.includes(text)) names.push(text);
    };
    add(resolveWorldbookName(context, settings));
    add(characterPrimaryWorld(context));
    for (const name of names) {
        let data = null;
        try {
            data = await context.loadWorldInfo(name);
        } catch {
            data = null;
        }
        const entry = coveringEntryInData(data, userText, query);
        if (entry) return { name, entry };
    }
    return null;
}

async function writeSearchToWorldbook(query, text, settings) {
    if (settings.writeToWorldbook === false) return "skip";
    const summary = String(text || "");
    if (!summary || summary.indexOf("没有拿到可用摘要") >= 0) return "empty";
    const context = tryGetContext();
    if (typeof context?.loadWorldInfo !== "function" || typeof context?.saveWorldInfo !== "function") return "no-api";
    const name = resolveWorldbookName(context, settings);
    if (!name) return "no-book";
    const data = await context.loadWorldInfo(name);
    if (!data || typeof data !== "object") return "load-failed";
    if (!data.entries || typeof data.entries !== "object") data.entries = {};
    const existing = findOwnedSearchEntry(data.entries, query);
    if (existing) {
        existing.key = buildWorldKeys(query);
        existing.content = summary;
        existing.comment = ownedSearchComment(query);
        existing.disable = false;
        existing.addMemo = true;
    } else {
        createOwnedSearchEntry(data, query, summary);
    }
    await context.saveWorldInfo(name, data, true);
    try {
        context.reloadWorldInfoEditor?.(name);
    } catch {
        // Editor refresh is optional; save already persisted the entry.
    }
    return "ok:" + name;
}

function setPrompt(text) {
    const context = tryGetContext();
    if (typeof context?.setExtensionPrompt !== "function") return false;
    context.setExtensionPrompt(PROMPT_KEY, String(text || ""), IN_CHAT, 0, false, SYSTEM_ROLE, null);
    return true;
}

function clearPrompt() {
    setPrompt("");
}

function currentChatId() {
    const context = tryGetContext();
    return String(context?.chatId ?? context?.characterId ?? "");
}

async function interceptGeneration(chat, _contextSize, _abort, type) {
    try {
        const settings = initializeSettings() || DEFAULT_SETTINGS;
        if (!settings.enabled) {
            clearPrompt();
            return;
        }
        if (hostCallBusy) return;
        if (type === "quiet" || type === "impersonate") return;

        const userText = lastUserText(chat);
        const aiText = lastAiText(chat);
        const previousQuery = extractAiSearchRequest(aiText);
        const skippedOriginal = listMatches(userText + "\n" + aiText, settings.skipKeywords)
            && !listMatches(userText + "\n" + aiText, settings.forceKeywords)
            && !previousQuery;
        let query = extractQuery(userText, combinedKeywords(settings), previousQuery);
        const reuse = type === "swipe" || type === "regenerate";
        const chatId = currentChatId();
        let wantSearch = shouldSearch(userText, settings, aiText);

        if (skippedOriginal) {
            setPrompt(buildPrompt("", settings, true));
            return;
        }

        if (!wantsFreshSearch(userText, settings)) {
            try {
                const coverage = await findWorldbookCoverage(userText, query, settings);
                if (coverage) {
                    clearPrompt();
                    return;
                }
            } catch (error) {
                console.warn("[" + MODULE_ID + "] worldbook coverage check failed", error);
            }
        }

        if (shouldPreflight(userText, settings, skippedOriginal, wantSearch, query)) {
            const judged = await preflightSearchQuery(userText);
            if (judged) {
                query = judged;
                wantSearch = true;
            } else if (!wantSearch) {
                setPrompt(buildPrompt("", settings, false));
                return;
            }
        }

        if (reuse && wantSearch && searchCache.text && searchCache.chatId === chatId && searchCache.query === query) {
            setPrompt(buildPrompt(searchCache.text, settings, false));
            return;
        }

        if (!wantSearch) {
            setPrompt(buildPrompt("", settings, false));
            return;
        }

        if (!query) {
            setPrompt(buildPrompt("", settings, false));
            return;
        }

        const text = await runSearch(query, settings);
        searchCache.chatId = chatId;
        searchCache.query = query;
        searchCache.text = text;
        setPrompt(buildPrompt(text, settings, false));
        try {
            const worldStatus = await writeSearchToWorldbook(query, text, settings);
            if (worldStatus !== "skip" && worldStatus !== "empty" && worldStatus !== "no-api" && !String(worldStatus).startsWith("ok")) {
                if (lastWorldbookWriteStatus !== worldStatus) {
                    lastWorldbookWriteStatus = worldStatus;
                    console.warn("[" + MODULE_ID + "] worldbook write: " + worldStatus);
                }
            } else if (String(worldStatus).startsWith("ok")) {
                lastWorldbookWriteStatus = worldStatus;
            }
        } catch (error) {
            console.warn("[" + MODULE_ID + "] worldbook write failed", error);
        }
    } catch (error) {
        console.warn("[" + MODULE_ID + "] intercept failed", error);
    }
}


function fallbackSettingsHtml(hostLabel) {
    return [
        '<div id="web-search-extension-root" class="web-search-extension" data-extension-id="web-search-extension">',
        '  <details open class="web-search-extension__panel">',
        '    <summary><b>联网搜索</b></summary>',
        '    <div class="web-search-extension__body">',
        '      <p class="web-search-extension__host">当前环境：<span data-host>' + hostLabel + '</span></p>',
        '      <label class="checkbox_label"><input id="web-search-extension-enabled" type="checkbox"><span>启用插件</span></label>',
        '      <label>什么时候搜索<select id="web-search-extension-mode" class="text_pole"><option value="smart">智能判断（推荐，不用打指令）</option><option value="keyword">只在有关键词时搜</option><option value="always">每轮都搜</option></select></label>',
        '      <label>普通触发词（逗号分隔）<input id="web-search-extension-keywords" class="text_pole" type="text"></label>',
        '      <label>同人/不可原创（命中就搜）<input id="web-search-extension-force" class="text_pole" type="text"></label>',
        '      <label>原创/架空（命中就不搜）<input id="web-search-extension-skip" class="text_pole" type="text"></label>',
        '      <label class="checkbox_label"><input id="web-search-extension-ai-request" type="checkbox"><span>生成正文前先让 AI 判断要不要搜（同人不能原创时会先搜再写）</span></label>',
        '      <label>搜索通道<select id="web-search-extension-source" class="text_pole"><option value="auto">先网页百科，失败再用主API（推荐）</option><option value="direct">只走网页百科</option><option value="mainApi">只跟随主API（用你正在聊的那套接口）</option></select></label>',
        '      <label class="checkbox_label"><input id="web-search-extension-qiuwen" type="checkbox"><span>求闻百科（大陆综合百科，默认）</span></label>',
        '      <label class="checkbox_label"><input id="web-search-extension-moegirl" type="checkbox"><span>萌娘百科（大陆二次元/同人资料，默认）</span></label>',
        '      <label class="checkbox_label"><input id="web-search-extension-wiki-zh" type="checkbox"><span>维基百科中文（海外备用，大陆常连不上）</span></label>',
        '      <label class="checkbox_label"><input id="web-search-extension-wiki-en" type="checkbox"><span>Wikipedia 英文（海外备用，大陆常连不上）</span></label>',
        '      <label class="checkbox_label"><input id="web-search-extension-ddg" type="checkbox"><span>DuckDuckGo 即时答案（海外，常被拦住）</span></label>',
        '      <label>自定义搜索地址（用 {{query}} 占位，可填自建 SearXNG/代理）<input id="web-search-extension-custom" class="text_pole" type="text" placeholder="https://example.com/search?q={{query}}"></label>',
        '      <label>Tavily API Key（可选，密钥只保存在本机扩展设置里）<input id="web-search-extension-tavily" class="text_pole" type="password" autocomplete="off"></label>',
        '      <label class="checkbox_label"><input id="web-search-extension-wb" type="checkbox"><span>写入世界书条目（找不到书就跳过，不新建书）</span></label>',
        '      <label>世界书名称（空=当前角色主世界书，没有则用已有的第一本）<input id="web-search-extension-wb-name" class="text_pole" type="text" placeholder="留空自动选择"></label>',
        '      <label class="checkbox_label"><input id="web-search-extension-skip-wb" type="checkbox"><span>世界书已有则不再搜索（省 token）</span></label>',
        '      <label>最多引用条数<input id="web-search-extension-max" class="text_pole" type="number" min="1" max="12"></label>',
        '      <div class="web-search-extension__row">',
        '        <input id="web-search-extension-test-query" class="text_pole" type="text" placeholder="试搜关键词">',
        '        <button id="web-search-extension-test" class="menu_button" type="button">试搜</button>',
        '      </div>',
        '      <pre id="web-search-extension-status" class="web-search-extension__status">尚未试搜。文件检查不等于已经装进酒馆。</pre>',
        '      <p class="web-search-extension__hint">检索发生在正文出现之前。同人/不能原创时会先安静判断、先搜索，再写故事。打开上面的判断开关后，回复会稍慢一轮。</p>',
        '    </div>',
        '  </details>',
        '</div>',
    ].join("\n");
}

function bindField(root, selector, eventName, handler) {
    const node = root.querySelector(selector);
    if (!node) return;
    node.addEventListener(eventName, handler);
}

function fillSettingsForm(root, settings) {
    const assign = (selector, value, checkbox = false) => {
        const node = root.querySelector(selector);
        if (!node) return;
        if (checkbox) node.checked = Boolean(value);
        else node.value = value ?? "";
    };
    assign("#web-search-extension-enabled", settings.enabled, true);
    assign("#web-search-extension-mode", getTriggerMode(settings));
    assign("#web-search-extension-keywords", settings.keywords);
    assign("#web-search-extension-force", settings.forceKeywords);
    assign("#web-search-extension-skip", settings.skipKeywords);
    assign("#web-search-extension-ai-request", settings.allowAiRequest !== false, true);
    assign("#web-search-extension-source", getSourceMode(settings));
    assign("#web-search-extension-qiuwen", settings.useQiuwen !== false, true);
    assign("#web-search-extension-moegirl", settings.useMoegirl !== false, true);
    assign("#web-search-extension-wiki-zh", settings.useWikipediaZh, true);
    assign("#web-search-extension-wiki-en", settings.useWikipediaEn, true);
    assign("#web-search-extension-ddg", settings.useDuckDuckGo, true);
    assign("#web-search-extension-custom", settings.customSearchUrl);
    assign("#web-search-extension-tavily", settings.tavilyApiKey);
    assign("#web-search-extension-max", settings.maxItems);
    assign("#web-search-extension-wb", settings.writeToWorldbook !== false, true);
    assign("#web-search-extension-wb-name", settings.worldbookName || "");
    assign("#web-search-extension-skip-wb", settings.skipIfInWorldbook !== false, true);
    const host = root.querySelector("[data-host]");
    if (host) host.textContent = detectHost();
}

function persistFromForm(root) {
    const settings = getSettings();
    const read = (selector, checkbox = false) => {
        const node = root.querySelector(selector);
        if (!node) return null;
        return checkbox ? node.checked : node.value;
    };
    settings.enabled = Boolean(read("#web-search-extension-enabled", true));
    const mode = String(read("#web-search-extension-mode") || "smart");
    settings.triggerMode = (mode === "keyword" || mode === "always") ? mode : "smart";
    settings.autoSearch = settings.triggerMode === "always";
    settings.keywords = String(read("#web-search-extension-keywords") ?? DEFAULT_SETTINGS.keywords);
    settings.forceKeywords = String(read("#web-search-extension-force") ?? DEFAULT_SETTINGS.forceKeywords);
    settings.skipKeywords = String(read("#web-search-extension-skip") ?? DEFAULT_SETTINGS.skipKeywords);
    settings.allowAiRequest = Boolean(read("#web-search-extension-ai-request", true));
    const sourceMode = read("#web-search-extension-source");
    if (sourceMode !== null) {
        settings.sourceMode = (sourceMode === "direct" || sourceMode === "mainApi") ? sourceMode : "auto";
    }
    const persistBox = (selector, key) => {
        const value = read(selector, true);
        if (value !== null) settings[key] = Boolean(value);
    };
    persistBox("#web-search-extension-qiuwen", "useQiuwen");
    persistBox("#web-search-extension-moegirl", "useMoegirl");
    persistBox("#web-search-extension-wiki-zh", "useWikipediaZh");
    persistBox("#web-search-extension-wiki-en", "useWikipediaEn");
    persistBox("#web-search-extension-ddg", "useDuckDuckGo");
    settings.customSearchUrl = String(read("#web-search-extension-custom") ?? "");
    settings.tavilyApiKey = String(read("#web-search-extension-tavily") ?? "");
    settings.maxItems = Math.max(1, Number(read("#web-search-extension-max")) || 6);
    const writeWb = read("#web-search-extension-wb", true);
    if (writeWb !== null) settings.writeToWorldbook = Boolean(writeWb);
    const wbName = read("#web-search-extension-wb-name");
    if (wbName !== null) settings.worldbookName = String(wbName || "");
    const skipWb = read("#web-search-extension-skip-wb", true);
    if (skipWb !== null) settings.skipIfInWorldbook = Boolean(skipWb);
    tryGetContext()?.saveSettingsDebounced?.();
    if (!settings.enabled) clearPrompt();
}

async function mountSettings() {
    const context = getContext();
    const hostLabel = detectHost();
    let html = "";
    try {
        html = await context.renderExtensionTemplateAsync(TEMPLATE_FOLDER, "settings", {
            displayName: "联网搜索",
            hostLabel,
        });
    } catch (error) {
        console.warn("[" + MODULE_ID + "] settings template fallback", error);
        html = fallbackSettingsHtml(hostLabel);
    }

    const panel = document.querySelector("#extensions_settings2")
        || document.querySelector("#extensions_settings")
        || document.querySelector("#extensions_settings1");
    if (!panel) return false;

    cleanupUi();
    const wrapper = document.createElement("div");
    wrapper.innerHTML = html;
    uiRoot = wrapper.firstElementChild || wrapper;
    panel.appendChild(uiRoot);

    fillSettingsForm(uiRoot, getSettings());

    const onChange = () => persistFromForm(uiRoot);
    [
        "#web-search-extension-enabled",
        "#web-search-extension-mode",
        "#web-search-extension-qiuwen",
        "#web-search-extension-moegirl",
        "#web-search-extension-wiki-zh",
        "#web-search-extension-wiki-en",
        "#web-search-extension-ddg",
        "#web-search-extension-keywords",
        "#web-search-extension-force",
        "#web-search-extension-skip",
        "#web-search-extension-ai-request",
        "#web-search-extension-source",
        "#web-search-extension-custom",
        "#web-search-extension-tavily",
        "#web-search-extension-max",
        "#web-search-extension-wb",
        "#web-search-extension-wb-name",
        "#web-search-extension-skip-wb",
    ].forEach((selector) => bindField(uiRoot, selector, "change", onChange));

    bindField(uiRoot, "#web-search-extension-test", "click", async () => {
        persistFromForm(uiRoot);
        const status = uiRoot.querySelector("#web-search-extension-status");
        const query = String(uiRoot.querySelector("#web-search-extension-test-query")?.value || "").trim();
        if (!query) {
            if (status) status.textContent = "请先填试搜关键词。";
            return;
        }
        if (status) status.textContent = "正在搜索…";
        try {
            const text = await runSearch(query, getSettings());
            if (status) status.textContent = text;
        } catch (error) {
            if (status) status.textContent = "试搜失败：" + (error?.message || error);
        }
    });

    uiCleanup = () => {
        uiRoot?.remove();
        uiRoot = null;
        uiCleanup = null;
    };
    return true;
}

function cleanupUi() {
    uiCleanup?.();
}

function registerSlashCommand() {
    if (slashRegistered) return;
    const context = tryGetContext();
    const {
        SlashCommandParser,
        SlashCommand,
        SlashCommandArgument,
        ARGUMENT_TYPE,
    } = context || {};
    if (!SlashCommandParser?.addCommandObject || !SlashCommand?.fromProps) {
        console.warn("[" + MODULE_ID + "] slash command API missing; /websearch not registered");
        return;
    }
    try {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: "websearch",
        aliases: ["ws"],
        returns: "search summary",
        helpString: "立刻联网搜索，并把摘要注入下一轮 AI 提示词。",
        unnamedArgumentList: SlashCommandArgument?.fromProps ? [
            SlashCommandArgument.fromProps({
                description: "要搜索的内容",
                typeList: ARGUMENT_TYPE?.STRING ? [ARGUMENT_TYPE.STRING] : ["string"],
                isRequired: true,
            }),
        ] : [],
        callback: async (_named, unnamed) => {
            const settings = getSettings();
            if (!settings.enabled) return "联网搜索插件已关闭。";
            const query = String(unnamed?.toString?.() ?? unnamed ?? "").trim();
            if (!query) return "请提供搜索词，例如 /websearch 今日赛果";
            const text = await runSearch(query, settings);
            searchCache.chatId = currentChatId();
            searchCache.query = query;
            searchCache.text = text;
            setPrompt(text);
            return text;
        },
    }));
    slashRegistered = true;
    } catch (error) {
        console.warn("[" + MODULE_ID + "] slash command register failed", error);
    }
}

function settingsPanelReady() {
    return Boolean(uiRoot && document.body.contains(uiRoot));
}

async function initOnce() {
    if (settingsPanelReady()) return;
    const context = tryGetContext();
    if (!context) {
        window.setTimeout(() => { void initOnce(); }, 400);
        return;
    }
    initializeSettings();
    registerSlashCommand();
    try {
        await mountSettings();
    } catch (error) {
        console.warn("[" + MODULE_ID + "] settings mount failed", error);
    }
    if (!settingsPanelReady()) {
        window.setTimeout(() => { void initOnce(); }, 400);
    }
}

function scheduleBoot() {
    const start = () => { void initOnce(); };
    const context = tryGetContext();
    if (context?.eventSource && context.event_types) {
        const types = context.event_types;
        if (types.APP_READY) context.eventSource.on(types.APP_READY, start);
        if (types.EXTENSION_SETTINGS_LOADED) context.eventSource.on(types.EXTENSION_SETTINGS_LOADED, start);
        if (types.SETTINGS_LOADED) context.eventSource.on(types.SETTINGS_LOADED, start);
    }
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
        start();
    }
    window.setTimeout(start, 800);
    window.setTimeout(start, 2500);
}

export function onInstall() {
    initializeSettings();
}

export function onActivate() {
    try {
        initializeSettings();
        scheduleBoot();
    } catch (error) {
        console.warn("[" + MODULE_ID + "] onActivate failed", error);
    }
}

export function onEnable() {
    try {
        initialized = false;
        initializeSettings();
        scheduleBoot();
    } catch (error) {
        console.warn("[" + MODULE_ID + "] onEnable failed", error);
    }
}

export function onDisable() {
    clearPrompt();
    cleanupUi();
    initialized = false;
}

export function onUpdate() {
    initializeSettings();
}

export function onDelete() {
    clearPrompt();
    cleanupUi();
}

export function onClean() {
    const context = tryGetContext();
    if (context?.extensionSettings) delete context.extensionSettings[MODULE_ID];
    context?.saveSettingsDebounced?.();
    clearPrompt();
    cleanupUi();
    initialized = false;
}

try {
    globalThis.WebSearchExt_interceptGeneration = interceptGeneration;
    scheduleBoot();
} catch (error) {
    console.warn("[" + MODULE_ID + "] boot failed", error);
}
