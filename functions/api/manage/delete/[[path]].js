import { createS3Client } from '../../../utils/storage/s3Client.js';
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { purgeCFCache, purgeRandomFileListCache, purgePublicFileListCache } from "../../../utils/purgeCache";
import { removeFileFromIndex, batchRemoveFilesFromIndex } from "../../../utils/indexManager.js";
import { getDatabase } from '../../../utils/databaseAdapter.js';
import { buildExpiryMarkerKey, getExpiresAt, isMissingRecord } from '../../../utils/fileExpiryHelpers.js';
import { DiscordAPI } from '../../../utils/storage/discordAPI.js';
import { HuggingFaceAPI } from '../../../utils/storage/huggingfaceAPI.js';
import { WebDAVAPI } from '../../../utils/storage/webdavAPI.js';
import {
    resolveDiscordCredentials,
    resolveHuggingFaceCredentials,
    resolveS3Credentials,
    resolveWebDAVCredentials,
} from '../../../utils/metadata/channelCredentials.js';

// CORS 跨域响应头
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
};

export async function onRequest(context) {
    const { request, env, params, waitUntil } = context;

    const url = new URL(request.url);

    // 读取folder参数，判断是否为文件夹删除请求
    const folder = url.searchParams.get('folder');
    if (folder === 'true') {
        try {
            params.path = decodeURIComponent(params.path);
            const folderQueue = [{
                path: params.path.split(',').join('/')
            }];

            const deletedFiles = [];
            const missingFiles = [];
            const failedFiles = [];
            const details = [];

            while (folderQueue.length > 0) {
                const currentFolder = folderQueue.shift();

                const listUrl = new URL(`${url.origin}/api/manage/list?count=-1&dir=${currentFolder.path}`);
                const listRequest = new Request(listUrl, {
                    headers: request.headers,
                });
                const listResponse = await fetch(listRequest);
                const listData = await listResponse.json();

                const files = listData.files;

                for (const file of files) {
                    const fileId = file.name;
                    const cdnUrl = `https://${url.hostname}/file/${fileId}`;

                    const result = await deleteFile(env, fileId, cdnUrl, url);
                    const success = !!(result && result.deleted);
                    details.push({ fileId, success, existed: !!result?.existed, error: success ? '' : 'Delete file failed' });
                    if (success) {
                        deletedFiles.push(fileId);
                        if (!result.existed) missingFiles.push(fileId);
                    } else {
                        failedFiles.push(fileId);
                    }
                }

                const directories = listData.directories;
                for (const dir of directories) {
                    folderQueue.push({
                        path: dir
                    });
                }
            }

            if (deletedFiles.length > 0) {
                waitUntil(batchRemoveFilesFromIndex(context, deletedFiles));
            }

            return new Response(JSON.stringify({
                success: true,
                deleted: deletedFiles,
                failed: failedFiles,
                missing: missingFiles,
                details
            }), {
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });

        } catch (e) {
            return new Response(JSON.stringify({
                success: false,
                error: e.message
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }
    }

    // 单个文件删除处理
    try {
        params.path = decodeURIComponent(params.path);
        const fileId = params.path.split(',').join('/');
        const cdnUrl = `https://${url.hostname}/file/${fileId}`;

        const result = await deleteFile(env, fileId, cdnUrl, url);
        if (!result || !result.deleted) {
            throw new Error('Delete file failed');
        } else {
            waitUntil(removeFileFromIndex(context, fileId));
        }

        return new Response(JSON.stringify({
            success: true,
            fileId: fileId,
            existed: result.existed
        }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    } catch (e) {
        return new Response(JSON.stringify({
            success: false,
            error: e.message
        }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    }
}

export async function deleteStoredFile(env, fileId, img) {
    if (img.metadata?.Channel === 'CloudflareR2') {
        const R2DataBase = env.img_r2;
        await R2DataBase.delete(fileId);
    }

    if (img.metadata?.Channel === 'S3') {
        return await deleteS3File(env, img);
    }

    if (img.metadata?.Channel === 'Discord') {
        return await deleteDiscordFile(env, img);
    }

    if (img.metadata?.Channel === 'HuggingFace') {
        return await deleteHuggingFaceFile(env, img);
    }

    if (img.metadata?.Channel === 'WebDAV') {
        return await deleteWebDAVFile(env, img);
    }

    return true;
}

// 删除单个文件的核心函数
export async function deleteFile(env, fileId, cdnUrl, url) {
    try {
        const db = getDatabase(env);
        const img = await db.getWithMetadata(fileId);

        if (isMissingRecord(img)) {
            console.warn(`File ${fileId} not found in database, skipping delete`);
            return { deleted: true, existed: false };
        }

        if (!await deleteStoredFile(env, fileId, img)) {
            throw new Error('storage channel reported a failed deletion');
        }

        // 删除数据库中的主记录
        await db.delete(fileId);

        // 联动删除关联的独立随机缩略图指针记录及缓存
        const thumbKey = img.metadata?.thumbKey;
        if (thumbKey) {
            try {
                await db.delete(thumbKey);
                await purgeCFCache(env, `https://${url.hostname}/file/${thumbKey}`);
            } catch (thumbErr) {
                console.warn(`Failed to delete paired thumb record ${thumbKey}:`, thumbErr);
            }
        }

        const expiresAt = getExpiresAt(img.metadata);
        if (expiresAt !== null && typeof db.listExpiredFiles !== 'function') {
            try {
                await db.delete(buildExpiryMarkerKey(expiresAt, fileId));
            } catch (error) {
                console.warn('Failed to remove deleted file expiry marker:', error);
            }
        }

        // 清除主图CDN缓存
        await purgeCFCache(env, cdnUrl);

        // 清除 api/randomFileList 等API缓存
        const normalizedFolder = fileId.split('/').slice(0, -1).join('/');
        await purgeRandomFileListCache(url.origin, normalizedFolder);
        await purgePublicFileListCache(url.origin, normalizedFolder);

        return { deleted: true, existed: true };
    } catch (e) {
        console.error('Delete file failed:', e);
        return { deleted: false, existed: true };
    }
}

async function deleteS3File(env, img) {
    const db = getDatabase(env);
    const s3Credentials = await resolveS3Credentials(db, env, img.metadata);
    const s3Client = createS3Client(s3Credentials);

    const bucketName = s3Credentials.bucketName;
    const key = s3Credentials.key;

    try {
        await s3Client.send(new DeleteObjectCommand({
            Bucket: bucketName,
            Key: key,
        }));
        return true;
    } catch (error) {
        console.error("S3 Delete Failed:", error);
        return false;
    }
}

async function deleteDiscordFile(env, img) {
    const db = getDatabase(env);
    const discordCredentials = await resolveDiscordCredentials(db, env, img.metadata);
    const botToken = discordCredentials.botToken;
    const channelId = discordCredentials.channelId;
    const messageId = discordCredentials.messageId;

    if (!botToken || !channelId || !messageId) {
        console.warn('Discord file missing required metadata for deletion');
        return false;
    }

    try {
        const discordAPI = new DiscordAPI(botToken);
        const success = await discordAPI.deleteMessage(channelId, messageId);
        if (!success) {
            console.error('Discord Delete Failed: API returned false');
        }
        return success;
    } catch (error) {
        console.error("Discord Delete Failed:", error);
        return false;
    }
}

async function deleteHuggingFaceFile(env, img) {
    const db = getDatabase(env);
    const hfCredentials = await resolveHuggingFaceCredentials(db, env, img.metadata);
    const token = hfCredentials.token;
    const repo = hfCredentials.repo;
    const filePath = hfCredentials.filePath;
    const isPrivate = hfCredentials.isPrivate || false;

    if (!token || !repo || !filePath) {
        console.warn('HuggingFace file missing required metadata for deletion');
        return false;
    }

    try {
        const huggingfaceAPI = new HuggingFaceAPI(token, repo, isPrivate);
        const success = await huggingfaceAPI.deleteFile(filePath, `Delete ${filePath}`);
        if (!success) {
            console.error('HuggingFace Delete Failed: API returned false');
        }
        return success;
    } catch (error) {
        console.error("HuggingFace Delete Failed:", error);
        return false;
    }
}

async function deleteWebDAVFile(env, img) {
    const filePath = img.metadata?.WebDAVFilePath;

    if (!filePath) {
        console.warn('WebDAV file missing required metadata for deletion');
        return false;
    }

    try {
        const db = getDatabase(env);
        const webdavCredentials = await resolveWebDAVCredentials(db, env, img.metadata);
        if (!webdavCredentials.baseUrl) {
            console.warn('WebDAV channel config not found for deletion');
            return false;
        }

        const webdavAPI = new WebDAVAPI(webdavCredentials);
        return await webdavAPI.deleteFile(filePath);
    } catch (error) {
        console.error("WebDAV Delete Failed:", error);
        return false;
    }
}
