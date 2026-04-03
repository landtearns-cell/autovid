const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');

/**
 * Uploads the generated file to the designated Webhook using multipart/form-data.
 * This is the standard way to accept binary files in n8n.
 */
async function sendResultToWebhook(finalVideoPath, webhookUrl) {
  try {
    console.log(`[Webhook] Preparing to send final video to ${webhookUrl}`);
    
    // Create a new form-data payload containing the binary video
    const form = new FormData();
    form.append('data', fs.createReadStream(finalVideoPath), {
      filename: 'final_edited_video.mp4',
      contentType: 'video/mp4',
    });

    // Make the POST request to n8n
    const response = await axios.post(webhookUrl, form, {
      headers: {
        ...form.getHeaders(),
      },
      // Give n8n some time to process the file upload
      timeout: 60000 
    });

    console.log(`[Webhook] Successfully sent video to n8n! Response Code: ${response.status}`);
    return true;
  } catch (error) {
    console.error(`[Webhook] Failed to send video to n8n:`, error.message);
    if (error.response) {
      console.error(`[Webhook] Response Data:`, error.response.data);
    }
    throw error;
  }
}

module.exports = {
  sendResultToWebhook
};
