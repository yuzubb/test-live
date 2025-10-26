const express = require('express');
const fetch = require('node-fetch'); 
const miniget = require('miniget'); 
const url = require('url');

const app = express();
const router = express.Router();
const PORT = 3000;

// ユーザーが提供した Invidious インスタンスのリスト
const INVIDIOUS_INSTANCES = [
    "https://invidious.f5.si", "https://yt.omada.cafe", "https://inv.perditum.com", 
    "https://iv.melmac.space", "https://invidious.nikkosphere.com", "https://iv.duti.dev", 
    "https://youtube.alt.tyil.nl", "https://inv.antopie.org", "https://lekker.gay", 
    "https://invidious.ducks.party", "https://super8.absturztau.be", "https://inv.vern.cc", 
    "https://yt.thechangebook.org", "https://invidious.materialio.us", "https://invid-api.poketube.fun"
];

const API_TIMEOUT_MS = 5000; // 5秒のタイムアウト
const HLS_FORMAT_NAME = 'hls'; // Invidious APIレスポンス内でHLSを示すと思われるフォーマット名

/**
 * HLSマニフェストの内容を読み取り、相対URLを絶対URLに変換します。
 * クライアントがセグメントファイル（.ts）を直接元の配信元から取得できるようにするために必要です。
 * @param {string} manifestContent - HLSマニフェスト（.m3u8）のテキスト内容
 * @param {string} baseUrl - マニフェストの取得元URL
 * @returns {string} - URLが絶対化されたマニフェスト内容
 */
const rewriteHlsManifest = (manifestContent, baseUrl) => {
    // URLのパス部分を除いたベースを取得 (例: https://example.com/path/master.m3u8 -> https://example.com/path/)
    const base = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);

    return manifestContent.split('\n').map(line => {
        // セグメントやサブプレイリストのURL行（#で始まらない行）を検索
        if (line.trim() && !line.startsWith('#')) {
            // URLが既に絶対URLであればスキップ
            if (line.startsWith('http://') || line.startsWith('https://') || line.startsWith('//')) {
                return line;
            }
            // 相対URLを絶対URLに変換
            try {
                return url.resolve(base, line.trim());
            } catch (e) {
                // 解決に失敗した場合は元の行を返す
                return line; 
            }
        }
        return line; // その他の行（#EXTINFなど）はそのまま返す
    }).join('\n');
};

/**
 * Invidiousインスタンスのリストを順に試行し、HLS URLを取得します。
 * @param {string} videoId - YouTubeの動画ID
 * @returns {Promise<string|null>} - 成功したHLS URL、または全て失敗した場合はnull
 */
const getHlsUrlFromInvidious = async (videoId) => {
    for (const instance of INVIDIOUS_INSTANCES) {
        // Invidious APIの動画情報エンドポイントを使用
        const apiUrl = `${instance}/api/v1/videos/${videoId}`;
        console.log(`[Invidious] 試行: ${instance}`);

        try {
            // fetchでAPIリクエストを行い、5秒でタイムアウトを設定
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
            
            const response = await fetch(apiUrl, { signal: controller.signal });
            clearTimeout(timeoutId); // 成功したらタイムアウトを解除

            if (!response.ok) {
                // HTTPエラー（404, 500など）の場合は次のインスタンスへ
                throw new Error(`HTTPエラー: ${response.status}`);
            }

            const videoInfo = await response.json();

            // APIレスポンスからHLSフォーマットのURLを探す
            // ライブ動画は通常、adaptiveFormatsまたはformatStreamsに含まれます。
            const formats = videoInfo.formatStreams || videoInfo.adaptiveFormats || [];
            
            const hlsFormat = formats.find(f => 
                f.container === HLS_FORMAT_NAME || 
                (f.qualityLabel && f.qualityLabel.toLowerCase().includes(HLS_FORMAT_NAME))
            );
            
            const hlsUrl = hlsFormat ? hlsFormat.url : null;

            if (hlsUrl) {
                console.log(`[Invidious] 成功! HLS URLを ${instance} から取得。`);
                return hlsUrl;
            } else {
                console.log(`[Invidious] HLS URLがレスポンスに見つかりませんでした (${instance})。次を試行します。`);
            }

        } catch (error) {
            if (error.name === 'AbortError') {
                console.log(`[Invidious] ${instance} でタイムアウト (${API_TIMEOUT_MS}ms)。次を試行します。`);
            } else {
                console.error(`[Invidious] ${instance} でAPI取得失敗: ${error.message}。次を試行します。`);
            }
            // 失敗した場合は次のインスタンスへ
            continue;
        }
    }

    return null; // 全てのインスタンスが失敗
};

// --------------------------------------------------------
// Express ルート定義
// --------------------------------------------------------

router.get("/get/:id", async (req, res) => {
    const videoId = req.params.id;
    if (!videoId) return res.redirect("/");

    // 1. InvidiousインスタンスからHLSマニフェストURLを取得 (タイムアウト&リトライロジックを含む)
    const hlsUrl = await getHlsUrlFromInvidious(videoId);

    if (!hlsUrl) {
        return res.status(500).send("全てのInvidiousインスタンスからライブストリームURLの取得に失敗しました。");
    }
    
    // クライアント向けの共通ヘッダーを設定
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    // HLSマニフェストのContent-Type
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");

    // 2. 取得したHLS URLをminigetでフェッチし、内容を処理
    let manifestContent = '';
    
    try {
        // minigetでHLSマニフェストのコンテンツを取得
        const stream = miniget(hlsUrl, { maxRedirects: 5, timeout: 10000 });
        
        manifestContent = await new Promise((resolve, reject) => {
            let data = '';
            stream.on('data', chunk => data += chunk);
            stream.on('end', () => resolve(data.toString()));
            stream.on('error', reject);
        });
        console.log(`HLSマニフェストの内容を取得完了: ${hlsUrl}`);

    } catch (error) {
        console.error(`最終的なHLSマニフェスト取得エラー (${hlsUrl}):`, error.message);
        // マニフェスト取得に失敗した場合も500エラーを返す
        if (!res.headersSent) {
            return res.status(500).send("HLSマニフェストのコンテンツ取得に失敗しました。");
        }
    }

    // 3. マニフェストの内容を書き換えて、相対URLを絶対URLに変換
    const absoluteManifest = rewriteHlsManifest(manifestContent, hlsUrl);

    // 4. 変換されたマニフェストをクライアントに送信
    res.send(absoluteManifest);
});

// ルーターをアプリケーションに適用
app.use('/', router);

// サーバー起動
app.listen(PORT, () => {
    console.log(`サーバーは http://localhost:${PORT} で実行中です。`);
    console.log(`使用方法: http://localhost:${PORT}/get/<YouTube_Video_ID>`);
});
