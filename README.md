# Auto Video Editor for n8n

This is a background processing server written in Node.js that takes a video, takes an audio file, and mathematically chunks screenshots from the video using a slide-left transition perfectly mapped to the length of the new audio. 

## Technical Details
This uses raw `FFmpeg` through the `fluent-ffmpeg` wrapper for maximum efficiency and least overhead, removing the need for a webGL server context. 

## Requirements
To execute this, you must install Node.js (version 18+ is recommended).
Once you place this on your server (like Render, DigitalOcean, or an Amazon EC2), you just run:
```bash
npm install
npm start
```
The server will start on port `3000`.

## Testing With n8n
Inside n8n, use an **HTTP Request** node to trigger the build.
- **Method:** `POST`
- **URL:** `http://your-server-ip:3000/process-video`
- **Authentication:** None
- **Body Parameters:** Ensure you send raw JSON.
  ```json
  {
      "videoUrl": "https://example.com/source_video.mp4",
      "audioUrl": "https://example.com/source_audio.mp3",
      "webhookUrl": "https://your-n8n-webhook-url/receive"
  }
  ```

### The Webhook Callback
Because generating video takes time, if n8n waited for it to finish, the HTTP Request would time out!
So the server will IMMEDIATELY reply with `200 OK` the second n8n asks it to build the video, and the real job runs in the background.

When it finishes, this server will upload `final_edited_video.mp4` securely back to the URL you specified in `webhookUrl` via a `multipart/form-data` binary upload. 

You should set up a **Webhook Node** in n8n listening to `POST` requests ending in `/receive` (or whatever you named it). Ensure n8n is set up to handle binary files!
