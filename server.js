const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");
const miniget = require("miniget");
const url = require('url');
const path = require("path");

const user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.198 Safari/537.36";

const INVIDIOUS_INSTANCES = [
    "https://invidious.f5.si", "https://yt.omada.cafe", "https://inv.perditum.com", 
    "https://iv.melmac.space", "https://invidious.nikkosphere.com", "https://iv.duti.dev", 
    "https://youtube.alt.tyil.nl", "https://inv.antopie.org", "https://lekker.gay", 
    "https://invidious.ducks.party", "https://super8.absturztau.be", "https://inv.vern.cc", 
    "https://yt.thechangebook.org", "https://invidious.materialio.us", "https://invid-api.poketube.fun"
];

const API_TIMEOUT_MS = 5000;
const HLS_FORMAT_NAME = 'hls'; 
const TARGET_DOMAIN = 'manifest.googlevideo.com'; // 新しいターゲットドメイン

const rewriteHlsManifest = (manifestContent, baseUrl) => {
    const base = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);

    return manifestContent.split('\n').map(line => {
        if (line.trim() && !line.startsWith('#')) {
            if (line.startsWith('http://') || line.startsWith('https://') || line.startsWith('//')) {
                return line;
            }
            try {
                return url.resolve(base, line.trim());
            } catch (e) {
                return line; 
            }
        }
        return line;
    }).join('\n');
};

const replaceDomain = (hlsUrl, newDomain) => {
    try {
        const parsedUrl = new URL(hlsUrl);
        parsedUrl.hostname = newDomain.replace(/https?:\/\//, '');
        parsedUrl.protocol = 'https:';
        return parsedUrl.toString();
    } catch (e) {
        console.error("Failed to replace domain:", e);
        return hlsUrl;
    }
};

const getHlsUrlFromInvidious = async (videoId) => {
    for (const instance of INVIDIOUS_INSTANCES) {
        const apiUrl = `${instance}/api/v1/videos/${videoId}`;
        console.log(`[Invidious] 試行: ${instance}`);

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
            
            const response = await fetch(apiUrl, { 
                signal: controller.signal, 
                headers: { 'User-Agent': user_agent } 
            });
            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`HTTPエラー: ${response.status}`);
            }

            const videoInfo = await response.json();

            const formats = videoInfo.formatStreams || videoInfo.adaptiveFormats || [];
            
            const hlsFormat = formats.find(f => 
                f.container === HLS_FORMAT_NAME || 
                (f.qualityLabel && f.qualityLabel.toLowerCase().includes(HLS_FORMAT_NAME))
            );
            
            let hlsUrl = hlsFormat ? hlsFormat.url : videoInfo.hlsUrl;

            if (hlsUrl) {
                // HLS URLが相対パスの場合、インスタンスのベースURLと結合して絶対URLにする
                if (!hlsUrl.startsWith('http')) {
                    hlsUrl = url.resolve(instance, hlsUrl);
                }
                
                console.log(`[Invidious] 成功! HLS URLを ${instance} から取得。`);
                return hlsUrl;
            } else {
                console.log(`[Invidious] HLS URLが見つかりませんでした (${instance})。次を試行します。`);
            }

        } catch (error) {
            if (error.name === 'AbortError') {
                console.log(`[Invidious] ${instance} でタイムアウト (${API_TIMEOUT_MS}ms)。次を試行します。`);
            } else {
                console.error(`[Invidious] ${instance} でAPI取得失敗: ${error.message}。次を試行します。`);
            }
            continue;
        }
    }
    return null;
};

// --------------------------------------------------------
// エンドポイント: HLS URL自体を返す
// --------------------------------------------------------
router.get("/get/url/:videoid", async (req, res) => {
    const videoId = req.params.videoid;
    if (!videoId) {
        return res.status(400).send("Video ID is required.");
    }

    const hlsUrl = await getHlsUrlFromInvidious(videoId);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Content-Type', 'text/plain');

    if (!hlsUrl) {
        return res.status(404).send("Failed to retrieve a valid HLS URL from all Invidious instances.");
    }
    
    // ドメインを manifest.googlevideo.com に置き換える
    const finalHlsUrl = replaceDomain(hlsUrl, TARGET_DOMAIN);
    
    // 取得した絶対URLをテキストとして返す
    res.send(finalHlsUrl);
});

// --------------------------------------------------------
// エンドポイント: HLS マニフェスト内容をプロキシする
// --------------------------------------------------------
router.get("/get/:id", async (req, res) => {
    const videoId = req.params.id;
    if (!videoId) return res.redirect("/");

    const hlsUrl = await getHlsUrlFromInvidious(videoId);

    if (!hlsUrl) {
        return res.status(500).send("全てのインスタンスからライブストリームURLの取得に失敗しました。");
    }
    
    // ドメインを manifest.googlevideo.com に置き換える
    const finalHlsUrl = replaceDomain(hlsUrl, TARGET_DOMAIN);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");

    let manifestContent = '';
    
    try {
        // 置換後のURLを使ってマニフェストを取得
        const stream = miniget(finalHlsUrl, { 
            maxRedirects: 5, 
            timeout: 10000, 
            headers: { 'User-Agent': user_agent } 
        });
        
        manifestContent = await new Promise((resolve, reject) => {
            let data = '';
            stream.on('data', chunk => data += chunk);
            stream.on('end', () => resolve(data.toString()));
            stream.on('error', reject); 
        });
        console.log(`HLSマニフェストの内容を取得完了: ${finalHlsUrl}`);

    } catch (error) {
        console.error(`最終的なHLSマニフェスト取得エラー (${finalHlsUrl}):`, error.message);
        if (!res.headersSent) {
            return res.status(500).send("HLSマニフェストのコンテンツ取得に失敗しました。");
        }
    }

    // rewriteHlsManifest には、マニフェストを取得したURL（置換後のURL）を渡す
    const absoluteManifest = rewriteHlsManifest(manifestContent, finalHlsUrl);

    res.send(absoluteManifest);
});

module.exports = router;

// --- サーバー起動コード ---
const app = express();
app.use(express.json());

app.use('/', router); 

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`サーバーはポート ${PORT} で実行中です。`);
    console.log(`URL取得: http://localhost:${PORT}/get/url/<YouTube_Video_ID>`);
    console.log(`プロキシ: http://localhost:${PORT}/get/<YouTube_Video_ID>`);
});
