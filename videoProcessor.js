const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');
const { sendResultToWebhook } = require('./webhookClient');
const os = require('os');

// Ensure ffmpeg knows where the binaries are
ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

async function downloadFile(url, filepath) {
    const writer = fs.createWriteStream(filepath);
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream'
    });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

function getDuration(filepath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filepath, (err, metadata) => {
            if (err) return reject(err);
            resolve(metadata.format.duration);
        });
    });
}

function generateScreenshots(videoPath, count, outputFolder) {
    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .screenshots({
                count: count,
                folder: outputFolder,
                filename: 'screenshot_%i.png',
                size: '854x480'
            })
            .on('end', () => {
                // Ensure the files actually exist and return paths
                const files = fs.readdirSync(outputFolder)
                    .filter(f => f.endsWith('.png'))
                    .sort((a, b) => {
                        const numA = parseInt(a.replace('screenshot_', ''));
                        const numB = parseInt(b.replace('screenshot_', ''));
                        return numA - numB;
                    })
                    .map(f => path.join(outputFolder, f));
                resolve(files);
            })
            .on('error', reject);
    });
}

function createChunk(imagePath, outputPath, duration) {
    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(imagePath)
            .inputOptions(['-loop 1', '-t ' + duration, '-framerate 30'])
            .outputOptions([
                '-vf', `fade=t=in:st=0:d=0.5,fade=t=out:st=${duration - 0.5}:d=0.5`,
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-threads', '1',
                '-pix_fmt', 'yuv420p',
                '-s', '854x480' // Guarantee standard resolution
            ])
            .save(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', reject);
    });
}

function concatChunksAndAudio(chunkFiles, audioPath, outputPath, workDir) {
    return new Promise((resolve, reject) => {
        const listFile = path.join(workDir, 'list.txt');
        const fileContent = chunkFiles.map(f => `file '${f}'`).join('\n');
        fs.writeFileSync(listFile, fileContent);

        ffmpeg()
            .input(listFile)
            .inputOptions(['-f concat', '-safe 0'])
            .input(audioPath)
            .outputOptions([
                '-c:v', 'copy', // Zero CPU copy, just stitches them together
                '-c:a', 'aac',
                '-b:a', '192k',
                '-shortest'
            ])
            .save(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', reject);
    });
}

async function processJob(videoUrl, audioUrl, webhookUrl) {
    const jobId = uuidv4();
    const workDir = path.join(os.tmpdir(), `job-${jobId}`);
    fs.mkdirSync(workDir, { recursive: true });

    const videoPath = path.join(workDir, 'source_video.mp4');
    const audioPath = path.join(workDir, 'source_audio.mp3');
    const outputPath = path.join(workDir, 'final_output.mp4');

    try {
        console.log(`[Job ${jobId}] Downloading inputs...`);
        await Promise.all([
            downloadFile(videoUrl, videoPath),
            downloadFile(audioUrl, audioPath)
        ]);

        console.log(`[Job ${jobId}] Getting durations...`);
        const audioDur = await getDuration(audioPath);
        
        // 5 seconds per chunk
        let numImages = Math.ceil(audioDur / 5);
        if (numImages < 1) numImages = 1;
        
        console.log(`[Job ${jobId}] Audio duration is ${audioDur}s. Extracting ${numImages} screenshots...`);
        const images = await generateScreenshots(videoPath, numImages, workDir);

        if (images.length === 0) {
            throw new Error('Failed to extract any images from the video.');
        }

        console.log(`[Job ${jobId}] Processing ${images.length} images into individual chunks...`);
        const chunkFiles = [];
        for (let i = 0; i < images.length; i++) {
            const chunkOut = path.join(workDir, `chunk_${i}.mp4`);
            await createChunk(images[i], chunkOut, 5);
            chunkFiles.push(chunkOut);
        }

        console.log(`[Job ${jobId}] Combining chunks and audio instantly...`);
        await concatChunksAndAudio(chunkFiles, audioPath, outputPath, workDir);

        console.log(`[Job ${jobId}] Sending to webhook...`);
        await sendResultToWebhook(outputPath, webhookUrl);

        console.log(`[Job ${jobId}] Completed Successfully!`);

    } catch (error) {
        console.error(`[Job ${jobId}] Failed with error:`, error);
        throw error;
    } finally {
        console.log(`[Job ${jobId}] Cleaning up temp files...`);
        fs.rmSync(workDir, { recursive: true, force: true });
    }
}

module.exports = { processJob };
