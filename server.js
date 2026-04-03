const express = require('express');
const { processJob } = require('./videoProcessor');

const app = express();
app.use(express.json());

app.post('/process-video', async (req, res) => {
  const { videoUrl, audioUrl, webhookUrl } = req.body;

  if (!videoUrl || !audioUrl || !webhookUrl) {
    return res.status(400).json({ error: 'Missing required parameters: videoUrl, audioUrl, webhookUrl' });
  }

  // 1. Immediately acknowledge the request to prevent n8n from timing out
  res.status(200).json({
    message: 'Video processing started successfully. Result will be sent to the provided webhookUrl.',
    jobType: 'video-edit',
    status: 'processing'
  });

  // 2. Start the processing in the background
  try {
    console.log(`[Job Started] Received job for webhookUrl: ${webhookUrl}`);
    await processJob(videoUrl, audioUrl, webhookUrl);
  } catch (error) {
    console.error(`[Job Failed] Error processing video:`, error);
    // Optionally: You could send a failure webhook back to n8n here if it fails
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Auto Video Editor server is listening on port ${PORT}`);
});
