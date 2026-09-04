import '../utils/logger';
import {cleanupLogger} from '../utils/logger';
import path from 'path';
import {XAuthClient} from "./utils";
import {get} from "lodash";
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import fs from 'fs-extra';

// 配置时区插件
dayjs.extend(utc);
dayjs.extend(timezone);
const TZ_BEIJING = 'Asia/Shanghai';

// 类型定义 ------------------------------------------------------------------------
interface EnrichedTweet {
    user: { screenName: string; name: string };
    images: string[];
    videos: string[];
    expandUrls: string[];
    tweetUrl: string;
    fullText: string;
    publishTime: string;
    userIdStr: string;
    isRetweet: boolean;
    isQuote: boolean;
}

interface ProcessConfig {
    /** 输出目录，默认'../tweets' */
    outputDir?: string;
    /** API请求间隔(ms)，默认10000 */
    interval?: number;
    /** 关注用户配置文件路径 */
    followingPath?: string;
    /** 是否过滤转推，默认true过滤 */
    filterRetweets?: boolean;
    /** 是否过滤引用推文，默认true过滤 */
    filterQuotes?: boolean;
}

// 主流程控制器 --------------------------------------------------------------------
export async function processHomeTimeline(client: any, config: ProcessConfig = {}) {
    const startTime = Date.now();

    // 新增配置合并逻辑
    const mergedConfig = await mergeConfigurations(config);
    const {
        outputDir = '../tweets',
        interval = 10000,
        followingPath = '../data/followingUser.json',
        filterRetweets = true,  // 新增默认值
        filterQuotes = true      // 新增默认值
    } = mergedConfig;

    console.log('===== [BEGIN] 首页时间线处理流程 =====\n');
    console.log('🕒 当前北京时间:', dayjs().tz(TZ_BEIJING).format('YYYY-MM-DD HH:mm:ss'));

    try {
        // 阶段1: 初始化配置
        logStep('1. 初始化配置');
        const [followingIds, timeThreshold] = await Promise.all([
            loadFollowingUsers(followingPath),
            calculateTimeThreshold(24)
        ]);
        console.log('⏰ 时间阈值:', timeThreshold.format('YYYY-MM-DD HH:mm:ss'));

        // 阶段2: 分页获取数据
        logStep('2. 分页获取数据');
        const {rawTweets, pageCount} = await paginateTweets(client, timeThreshold, interval);

        // 阶段3: 数据处理
        logStep('3. 数据处理');
        const {validTweets, counter} = processTweets(
            rawTweets,
            followingIds,
            timeThreshold,
            {
                filterRetweets,
                filterQuotes
            }
        );
        // 阶段4: 数据存储
        logStep('4. 数据存储');
        await saveTweets(validTweets, outputDir);

        // 最终统计
        const timeCost = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log('\n✅ 处理完成!');
        console.log(`
🎉 处理完成！
📊 总请求次数: ${pageCount}
📦 总原始数据: ${rawTweets.length}
✅ 有效推文数: ${validTweets.length}
🚫 过滤转推: ${counter.retweets}
🚫 过滤引用: ${counter.quotes}
🙅 非关注用户: ${counter.nonFollowing}
⌛ 超时数据: ${counter.outOfRange}
⏱ 耗时(秒): ${timeCost}
`);

    } catch (error) {
        console.error('\n❌ 流程异常终止:', error.message);
        throw error;
    }
}

async function mergeConfigurations(cliConfig: ProcessConfig): Promise<ProcessConfig> {
    // 默认配置
    const defaultConfig = {
        outputDir: '../tweets',
        interval: 10000,
        followingPath: '../data/followingUser.json',
        filterRetweets: true,
        filterQuotes: true
    };

    // 文件配置
    let fileConfig = {};
    try {
        const configPath = path.resolve(__dirname, '../../config/config.json');
        fileConfig = await fs.readJSON(configPath);
        console.log('✅ 加载配置文件成功');
    } catch (e) {
        if (e.code === 'ENOENT') {
            console.log('ℹ️ 未找到配置文件，使用默认配置');
        } else {
            console.warn('⚠️ 配置文件解析失败:', e.message);
        }
    }

    // 合并配置（优先级：CLI参数 > 文件配置 > 默认配置）
    return {
        ...defaultConfig,
        ...fileConfig,
        ...cliConfig
    };
}

// 核心逻辑函数 --------------------------------------------------------------------
/** 分页获取推文（含时间过滤） */
async function paginateTweets(client: any, threshold: dayjs.Dayjs, interval: number) {
    console.log('⏳ 开始分页抓取，终止条件: 最后一条推文时间 <', threshold.format('YYYY-MM-DD HH:mm:ss'));
    let cursor: string | undefined;
    let rawTweets: any[] = [];
    let pageCount = 0;
    let lastTweetTime: dayjs.Dayjs | null = null;

    do {
        pageCount++;
        const {tweets, newCursor} = await fetchTweetPage(client, cursor, interval, pageCount);
        cursor = newCursor;

        // 记录最后一条时间
        if (tweets.length > 0) {
            const lastCreatedAt = get(tweets[tweets.length - 1], 'tweet.legacy.createdAt');
            lastTweetTime = convertToBeijingTime(lastCreatedAt);
            console.log(`最后一条时间: ${lastTweetTime?.format('YYYY-MM-DD HH:mm:ss')}`);
        }

        // 保存响应信息逻辑
        const timestamp = dayjs().format('YYYYMMDD-HHmmss');
        const saveDir = path.resolve(__dirname, '../resp/respHomeTimeline');
        const filename = `page_${pageCount}_${timestamp}.json`;
        try {
            if (!fs.existsSync(saveDir)) {
                fs.mkdirSync(saveDir, {recursive: true});
            }
            const filePath = path.join(saveDir, filename);
            await fs.promises.writeFile(
                filePath,
                JSON.stringify(tweets, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2),
                'utf-8'
            );
            console.log(`💾 第 ${pageCount} 页响应已保存至：${filename}`);
        } catch (e) {
            console.error(`❌ 保存响应失败：`, e instanceof Error ? e.message : e);
        }

        // 合并数据（不过滤）
        rawTweets.push(...tweets);

        // 终止条件：无更多数据 或 最后一条超时
        const shouldContinue = cursor && (!lastTweetTime || lastTweetTime.isAfter(threshold));
        console.log(`分页查询标志位: ${shouldContinue}`);

    } while (cursor && lastTweetTime?.isAfter(threshold));

    console.log(`📦 分页完成，共请求 ${pageCount} 次，获取原始数据 ${rawTweets.length} 条`);
    return {rawTweets, pageCount};
}

/** 处理单页数据 */
async function fetchTweetPage(
    client: any,
    cursor: string | undefined,
    interval: number,
    pageNum: number,
) {
    console.log(`\n=== 分页请求 #${pageNum} ===`);
    console.log('⏱️ 请求时间:', dayjs().tz(TZ_BEIJING).format('YYYY-MM-DD HH:mm:ss'));
    if (cursor) console.log(`📍 当前游标: ${cursor}`);

    // 速率限制（加随机抖动，降低风控特征）
    if (pageNum > 1) {
        const jittered = Math.round(interval * (0.7 + Math.random() * 0.6));
        console.log(`⏸️ 等待 ${Math.round(jittered / 100) / 10} 秒...`);
        await new Promise(resolve => setTimeout(resolve, jittered));
    }

    // API请求
    const response = await client.getTweetApi().getHomeLatestTimeline({
        count: 100,
        cursor
    });

    // 提取嵌套回复
    const originalTweets = response.data?.data || [];
    const replyTweets = collectNestedReplies(originalTweets, 0);
    console.log(`↪ 本页数据: 原始 ${originalTweets.length} 条 + 回复 ${replyTweets.length} 条`);

    return {
        tweets: [...originalTweets, ...replyTweets],
        newCursor: response.data?.cursor?.bottom?.value
    };
}

/** 数据处理管道 */
function processTweets(
    rawTweets: any[],
    followingIds: Set<string>,
    threshold: dayjs.Dayjs,
    config: {
        filterRetweets: boolean;
        filterQuotes: boolean;
    }
) {
    console.log('\n🔧 开始处理原始数据...');
    const counter = {retweets: 0, quotes: 0, nonFollowing: 0, outOfRange: 0};
    const validTweets: EnrichedTweet[] = [];

    rawTweets.forEach((item, index) => {
        // 转换数据
        const tweet = transformTweet(item);
        if (!tweet) return;

        // 过滤转推
        if (config.filterRetweets && tweet.isRetweet) {
            counter.retweets++;
            return;
        }
        // 过滤引用推文
        if (config.filterQuotes && tweet.isQuote) {
            counter.quotes++;
            return;
        }

        // 过滤非关注用户
        if (!followingIds.has(tweet.userIdStr)) {
            counter.nonFollowing++;
            return;
        }

        // 时间过滤
        const publishTime = dayjs(tweet.publishTime);
        if (publishTime.isBefore(threshold)) {
            counter.outOfRange++;
            return;
        }

        validTweets.push(tweet);
    });

    console.log('✅ 数据处理完成');
    console.log(`→ 有效数据: ${validTweets.length}/${rawTweets.length}`);
    return {validTweets, counter};
}

// 工具函数 ------------------------------------------------------------------------
/** 加载关注用户列表 */
async function loadFollowingUsers(path: string): Promise<Set<string>> {
    console.log(`📂 加载关注列表: ${path}`);
    try {
        const data = await fs.readJSON(path);
        const ids = data.map((u: any) => u.restId);
        console.log(`→ 成功加载 ${ids.length} 个关注用户`);
        return new Set(ids);
    } catch (error) {
        console.error('❌ 加载关注列表失败:', error.message);
        return new Set();
    }
}

/** 收集嵌套回复（最多5层） */
function collectNestedReplies(tweets: any[], depth: number):
    any[] {
    if (depth >= 5) {
        console.log(`↳ 停止递归，当前深度: ${depth}`);
        return [];
    }

    return tweets.flatMap(tweet => {
        const replies = tweet.replies || [];
        const nested = collectNestedReplies(replies, depth + 1);
        return [...replies, ...nested];
    });
}

/** 转换原始推文数据 */
function transformTweet(item: any): EnrichedTweet | null {
    try {
        // 关键字段提取
        const userIdStr = get(item, 'tweet.legacy.userIdStr');
        const screenName = get(item, 'user.legacy.screenName');
        const createdAt = get(item, 'tweet.legacy.createdAt');

        if (!userIdStr || !screenName || !createdAt) {
            console.log('🛑 数据缺失，跳过条目');
            return null;
        }

        // 时间转换
        const beijingTime = convertToBeijingTime(createdAt);
        if (!beijingTime.isValid()) {
            console.log('🕒 时间解析失败:', createdAt);
            return null;
        }
        const fullText = get(item, 'tweet.legacy.fullText', '');
        const isRetweet = fullText.startsWith('RT @');
        const isQuote = get(item, 'tweet.legacy.isQuoteStatus', false);

        const publishTime = beijingTime.format('YYYY-MM-DDTHH:mm:ss');

        // 构造对象
        return {
            user: {
                screenName,
                name: get(item, 'user.legacy.name') || '未知用户'
            },
            images: extractMedia(item, 'photo'),
            videos: extractVideo(item),
            expandUrls: extractUrls(item),
            tweetUrl: `https://x.com/${screenName}/status/${get(item, 'tweet.legacy.idStr')}`,
            fullText,
            publishTime,
            userIdStr,
            isRetweet,
            isQuote
        };

    } catch (error) {
        console.error('❌ 数据转换异常:', error.message);
        return null;
    }
}

// 辅助函数 ------------------------------------------------------------------------
/** 计算时间阈值（当前时间-24小时） */
function calculateTimeThreshold(hours: number): dayjs.Dayjs {
    return dayjs().tz(TZ_BEIJING).subtract(hours, 'hour');
}

/** 转换到北京时间 */
function convertToBeijingTime(dateStr: string): dayjs.Dayjs {
    return dayjs(dateStr).tz(TZ_BEIJING);
}

/** 提取图片链接 */
function extractMedia(item: any, type: 'photo'): string[] {
    return get(item, 'tweet.legacy.extendedEntities.media', [])
        .filter((m: any) => m.type === type)
        .map((m: any) => m.mediaUrlHttps);
}

/** 提取视频链接 */
function extractVideo(item: any): string[] {
    return get(item, 'tweet.legacy.extendedEntities.media', [])
        .filter((m: any) => ['video', 'animated_gif'].includes(m.type))
        .map((m: any) => {
            const variants = get(m, 'videoInfo.variants', []);
            const best = variants
                .filter((v: any) => v.contentType === 'video/mp4')
                .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0];
            return best?.url;
        })
        .filter(Boolean);
}

/** 提取扩展链接 */
function extractUrls(item: any): string[] {
    return get(item, 'tweet.legacy.entities.urls', [])
        .map((u: any) => u.expandedUrl)
        .filter(Boolean);
}

/** 数据存储到对应日期的文件 */
async function saveTweets(tweets: EnrichedTweet[], outputDir: string) {
    console.log('\n📂 开始数据存储...');
    const dateGroups = tweets.reduce((acc, tweet) => {
        const dateKey = dayjs(tweet.publishTime).tz(TZ_BEIJING).format('YYYY-MM-DD');
        (acc[dateKey] || (acc[dateKey] = [])).push(tweet);
        return acc;
    }, {} as Record<string, EnrichedTweet[]>);

    console.log(`→ 发现 ${Object.keys(dateGroups).length} 个日期分组`);

    for (const [dateStr, group] of Object.entries(dateGroups)) {
        const monthDir = dayjs(dateStr).format('YYYY-MM');
        const filePath = path.join(outputDir, monthDir, `${dateStr}.json`);
        await saveGroup(filePath, group);
    }
}

/** 保存单个日期组数据 */
async function saveGroup(filePath: string, newTweets: EnrichedTweet[]) {
    try {
        fs.ensureDirSync(path.dirname(filePath));

        // 读取现有数据
        const existing: EnrichedTweet[] = fs.existsSync(filePath)
            ? await fs.readJSON(filePath)
            : [];
        console.log(`读取现有数据: ${existing.length} 条 (${filePath})`);

        // 合并去重
        const uniqueMap = new Map<string, EnrichedTweet>();
        [...existing, ...newTweets].forEach(t => {
            const key = `${t.tweetUrl}_${t.publishTime}`;
            if (!uniqueMap.has(key)) uniqueMap.set(key, t);
        });

        // 过滤非当日数据(升序排序)
        const targetDate = path.basename(filePath, '.json');
        const filtered = Array.from(uniqueMap.values())
            .filter(t => dayjs(t.publishTime).tz(TZ_BEIJING).format('YYYY-MM-DD') === targetDate)
            .sort((a, b) => dayjs(a.publishTime).unix() - dayjs(b.publishTime).unix());

        // 写入文件
        const dataToSave = filtered.map(
            ({userIdStr, isRetweet, isQuote, ...rest}) => rest
        );
        await fs.writeJSON(filePath, dataToSave, {spaces: 2});
        console.log(`✔ 保存成功: ${targetDate}.json (新增 ${newTweets.length} → 总计 ${dataToSave.length})`);

    } catch (error) {
        console.error(`❌ 保存失败 (${filePath}):`, error.message);
    }
}

// 日志工具 ------------------------------------------------------------------------
function logStep(message: string) {
    console.log(`\n## ${message} ##`);
}

// 启动入口 ------------------------------------------------------------------------
export async function main() {
    try {
        const client = await XAuthClient();
        await processHomeTimeline(client);
    } catch (error) {
        console.error('❌ 全局异常:', error);
        process.exitCode = 1;
    } finally {
        // 统一资源清理
        await cleanupLogger();
        process.exit();
    }
}

main();