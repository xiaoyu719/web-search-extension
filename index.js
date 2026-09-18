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
    useWikipediaZh: true,
    useWikipediaEn: true,
    useDuckDuckGo: true,
    customSearchUrl: "",
    tavilyApiKey: "",
    maxItems: 6,
});

const searchCache = { chatId: "", query: "", text: "" };
let initialized = false;
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
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
            if (!Object.prototype.hasOwnProperty.call(current, key)) current[key] = DEFAULT_SETTINGS[key];
        }
        if (!hadTriggerMode) current.triggerMode = current.autoSearch ? "always" : "smart";
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


async function searchWikipedia(lang, query, signal) {
    const host = lang === "zh" ? "zh.wikipedia.org" : "en.wikipedia.org";
    const url = "https://" + host + "/w/api.php?action=opensearch&search=" + encodeURIComponent(query) + "&limit=5&namespace=0&format=json&origin=*";
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error("Wikipedia " + lang + " HTTP " + response.status);
    const data = await response.json();
    const titles = Array.isArray(data?.[1]) ? data[1] : [];
    const snippets = Array.isArray(data?.[2]) ? data[2] : [];
    const links = Array.isArray(data?.[3]) ? data[3] : [];
    return titles.map((title, index) => ({
        source: lang === "zh" ? "维基百科中文" : "Wikipedia",
        title: String(title || ""),
        snippet: String(snippets[index] || ""),
        url: String(links[index] || ""),
    })).filter((item) => item.title);
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

async function runSearch(query, settings) {
    const jobs = [];
    if (settings.useWikipediaZh) jobs.push(["维基百科中文", (signal) => searchWikipedia("zh", query, signal)]);
    if (settings.useWikipediaEn) jobs.push(["Wikipedia", (signal) => searchWikipedia("en", query, signal)]);
    if (settings.useDuckDuckGo) jobs.push(["DuckDuckGo", (signal) => searchDuckDuckGo(query, signal)]);
    if (String(settings.customSearchUrl || "").trim()) {
        jobs.push(["自定义搜索", (signal) => searchCustom(settings.customSearchUrl, query, signal)]);
    }
    if (String(settings.tavilyApiKey || "").trim()) {
        jobs.push(["Tavily", (signal) => searchTavily(settings.tavilyApiKey, query, signal)]);
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
            const message = error?.name === "AbortError" ? "超时" : (error?.message || String(error));
            notes.push(label + "失败：" + message);
        } finally {
            clock.done();
        }
    }));

    if (!jobs.length) notes.push("未启用任何搜索源");
    return formatResults(query, items, notes);
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
        '      <label class="checkbox_label"><input id="web-search-extension-wiki-zh" type="checkbox"><span>维基百科中文（适合跨域）</span></label>',
        '      <label class="checkbox_label"><input id="web-search-extension-wiki-en" type="checkbox"><span>Wikipedia 英文（适合跨域）</span></label>',
        '      <label class="checkbox_label"><input id="web-search-extension-ddg" type="checkbox"><span>DuckDuckGo 即时答案（可能被跨域拦住）</span></label>',
        '      <label>自定义搜索地址（用 {{query}} 占位，可填自建 SearXNG/代理）<input id="web-search-extension-custom" class="text_pole" type="text" placeholder="https://example.com/search?q={{query}}"></label>',
        '      <label>Tavily API Key（可选，密钥只保存在本机扩展设置里）<input id="web-search-extension-tavily" class="text_pole" type="password" autocomplete="off"></label>',
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
    assign("#web-search-extension-wiki-zh", settings.useWikipediaZh, true);
    assign("#web-search-extension-wiki-en", settings.useWikipediaEn, true);
    assign("#web-search-extension-ddg", settings.useDuckDuckGo, true);
    assign("#web-search-extension-custom", settings.customSearchUrl);
    assign("#web-search-extension-tavily", settings.tavilyApiKey);
    assign("#web-search-extension-max", settings.maxItems);
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
    settings.useWikipediaZh = Boolean(read("#web-search-extension-wiki-zh", true));
    settings.useWikipediaEn = Boolean(read("#web-search-extension-wiki-en", true));
    settings.useDuckDuckGo = Boolean(read("#web-search-extension-ddg", true));
    settings.customSearchUrl = String(read("#web-search-extension-custom") ?? "");
    settings.tavilyApiKey = String(read("#web-search-extension-tavily") ?? "");
    settings.maxItems = Math.max(1, Number(read("#web-search-extension-max")) || 6);
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
        "#web-search-extension-wiki-zh",
        "#web-search-extension-wiki-en",
        "#web-search-extension-ddg",
        "#web-search-extension-keywords",
        "#web-search-extension-force",
        "#web-search-extension-skip",
        "#web-search-extension-ai-request",
        "#web-search-extension-custom",
        "#web-search-extension-tavily",
        "#web-search-extension-max",
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
