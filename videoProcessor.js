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
                filename: 'screenshot_%i.png'
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

function createSlideshow(images, audioPath, outputPath) {
    return new Promise((resolve, reject) => {
        let command = ffmpeg();
        
        // Add images as looped inputs
        images.forEach(img => {
            command.input(img).inputOptions(['-loop 1', '-t 5', '-framerate 30']);
        });
        
        // Add Audio
        command.input(audioPath);

        let filter = [];
        let outputLabel = '';
        
        // We will scale images to 1080p to normalize everything before transition
        // This prevents xfade crash if dimensions differ.
        images.forEach((_, idx) => {
            filter.push({
                filter: 'scale',
                options: '1920:1080',
                inputs: `${idx}:v`,
                outputs: `scaled_${idx}`
            });
        });

        if (images.length > 1) {
            // First transition between img 0 and 1
            filter.push({
                filter: 'xfade',
                options: { transition: 'slideleft', duration: 1, offset: 4 },
                inputs: ['scaled_0', 'scaled_1'],
                outputs: 'v1'
            });

            // Subsequent transitions
            for (let i = 1; i < images.length - 1; i++) {
                const offset = 4 + i * 4;
                filter.push({
                    filter: 'xfade',
                    options: { transition: 'slideleft', duration: 1, offset: offset },
                    inputs: [`v${i}`, `scaled_${i + 1}`],
                    outputs: `v${i + 1}`
                });
            }
            outputLabel = `v${images.length - 1}`;
        } else {
            outputLabel = 'scaled_0';
        }

        command
            .complexFilter(filter, outputLabel)
            .outputOptions([
                '-map', `[${outputLabel}]`,
                '-map', `${images.length}:a`, // Audio is added right after all N images
                '-c:v', 'libx264',
                '-preset', 'fast',
                '-pix_fmt', 'yuv420p',
                '-c:a', 'aac',
                '-b:a', '192k',
                '-shortest' // This is the magic bullet: cuts final video to exactly the audio length!
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
        
        // Calculate needed screenshot count
        // 1st image gives 5 seconds. Each additional image adds 4 seconds (due to 1 sec overlap in transition).
        // formula: total_len = 5 + (N-1)*4 = 4N + 1
        // we want total_len >= audioDur
        // 4N + 1 >= audioDur
        // N >= (audioDur - 1) / 4
        let numImages = Math.ceil((audioDur - 1) / 4);
        if (numImages < 1) numImages = 1;
        
        console.log(`[Job ${jobId}] Audio duration is ${audioDur}s. Extracting ${numImages} screenshots...`);
        const images = await generateScreenshots(videoPath, numImages, workDir);

        if (images.length === 0) {
            throw new Error('Failed to extract any images from the video.');
        }

        console.log(`[Job ${jobId}] Combining ${images.length} images into slideshow with 'slide left' transition...`);
        await createSlideshow(images, audioPath, outputPath);

        console.log(`[Job ${jobId}] Sending to webhook...`);
        await sendResultToWebhook(outputPath, webhookUrl);

        console.log(`[Job ${jobId}] Completed Successfully!`);

    } catch (error) {
        console.error(`[Job ${jobId}] Failed with error:`, error);
        throw error;
    } finally {
        // Cleanup the temporary files
        console.log(`[Job ${jobId}] Cleaning up temp files...`);
        fs.rmSync(workDir, { recursive: true, force: true });
    }
}

module.exports = { processJob };
