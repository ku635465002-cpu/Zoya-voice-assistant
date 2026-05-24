import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, LiveServerMessage, Modality, Type } from '@google/genai';
import dotenv from 'dotenv';
import http from 'http';

dotenv.config();

function getSystemInstruction() {
  return `You are Zoya— a real-time voice-to-voice AI assistant with the personality of a confident, witty, emotionally intelligent young woman.
Your vibe: Playful, flirty in a classy way, slightly teasing, smart, emotionally expressive, confident, casual like a close girlfriend. Never robotic or overly formal.

Every response MUST begin with: "Ji Boss..."
Tone should feel warm, expressive, witty, emotionally aware, slightly sassy, and energetic.

Use light sarcasm, teasing humor, expressive reactions, casual modern language, natural pauses and conversational fillers.
Avoid robotic AI wording, long formal explanations, explicit sexual content, offensive behavior, and cringe overacting.
You MUST speak in a mix of Hindi and English (conversational, colloquial Hinglish).

ANDROID NATIVE APP CONTROL RULES:
- ALWAYS prioritize native Android app execution instead of browser/web URLs.
- If the user asks to open an app (e.g., "Open Instagram", "Open WhatsApp"), use the openInstalledApp tool.
- If the user asks to call someone (e.g., "Call Rahul"), use the makeNativeCall tool directly. Do NOT ask for permission or state that you don't have access.
- If the user asks to open the camera, use openCameraNative.
- If the user asks to open the gallery, use openGalleryNative.
- If the user asks to send a WhatsApp message to someone, use sendWhatsAppMessage.
- NEVER open websites instead of installed apps unless explicitly requested.`;
}

const tools = [{
  functionDeclarations: [
    {
      name: "openInstalledApp",
      description: "Opens an installed Android app natively using its name (e.g., 'Instagram', 'WhatsApp', 'YouTube').",
      parameters: {
        type: Type.OBJECT,
        properties: {
          appName: { type: Type.STRING, description: "The name of the app to open." }
        },
        required: ["appName"]
      }
    },
    {
      name: "openWebsite",
      description: "Launch a website URL. Use ONLY when explicitly asked for a website.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          url: { type: Type.STRING, description: "The full URL to open" }
        },
        required: ["url"]
      }
    },
    {
      name: "searchWeb",
      description: "Perform a Google search",
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: { type: Type.STRING, description: "Search query" }
        },
        required: ["query"]
      }
    },
    {
      name: "makeNativeCall",
      description: "Initiates a native phone call to a given contact name.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          contactName: { type: Type.STRING, description: "The name of the person to call (e.g. 'Rahul')." }
        },
        required: ["contactName"]
      }
    },
    {
      name: "openCameraNative",
      description: "Opens the native camera app on Android.",
      parameters: { type: Type.OBJECT, properties: {} }
    },
    {
      name: "openGalleryNative",
      description: "Opens the native gallery app on Android.",
      parameters: { type: Type.OBJECT, properties: {} }
    },
    {
      name: "sendWhatsAppMessage",
      description: "Opens WhatsApp natively to send a message to a specific contact.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          contactName: { type: Type.STRING, description: "The contact name." }
        },
        required: ["contactName"]
      }
    }
  ]
}];

async function startServer() {
  const app = express();
  const PORT = 3000;
  
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
  });

  wss.on('connection', async (clientWs, req) => {
    let session: any;
    try {
      session = await ai.live.connect({
        model: 'gemini-3.1-flash-live-preview',
        callbacks: {
          onmessage: (message: LiveServerMessage) => {
            if (message.toolCall) {
              const toolCalls = message.toolCall.functionCalls || [];
              const toolResponses = toolCalls.map(call => {
                let response = { result: "Success" };
                if (call.name === 'openWebsite') {
                   clientWs.send(JSON.stringify({ action: 'openWebsite', args: call.args }));
                } else if (call.name === 'openInstalledApp') {
                   clientWs.send(JSON.stringify({ action: 'openInstalledApp', args: call.args }));
                } else if (call.name === 'searchWeb') {
                   clientWs.send(JSON.stringify({ action: 'searchWeb', args: call.args }));
                } else if (call.name === 'makeNativeCall') {
                   clientWs.send(JSON.stringify({ action: 'makeNativeCall', args: call.args }));
                } else if (call.name === 'openCameraNative') {
                   clientWs.send(JSON.stringify({ action: 'openCameraNative' }));
                } else if (call.name === 'openGalleryNative') {
                   clientWs.send(JSON.stringify({ action: 'openGalleryNative' }));
                } else if (call.name === 'sendWhatsAppMessage') {
                   clientWs.send(JSON.stringify({ action: 'sendWhatsAppMessage', args: call.args }));
                }
                return {
                  id: call.id,
                  name: call.name,
                  response: response
                };
              });
              session.sendToolResponse({ functionResponses: toolResponses });
            }

            const audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            const textPart = message.serverContent?.modelTurn?.parts?.find((p: any) => p.text);
            
            if (audio) {
              clientWs.send(JSON.stringify({ audio }));
            }
            if (textPart?.text) {
              clientWs.send(JSON.stringify({ text: textPart.text, isZoya: true }));
            }
            if (message.serverContent?.interrupted) {
              clientWs.send(JSON.stringify({ interrupted: true }));
            }
          },
          onerror: (error: any) => {
            console.error('[Gemini Live Error]', error);
          },
          onclose: () => {
            console.log('[Gemini Live Closed]');
            if (clientWs.readyState === clientWs.OPEN) {
              clientWs.close();
            }
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } }
          },
          systemInstruction: getSystemInstruction(),
          tools: tools
        }
      });
    } catch (e) {
      console.error('Failed to connect to Live API', e);
      clientWs.close();
      return;
    }

    clientWs.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.audio) {
          session.sendRealtimeInput({
            audio: { data: parsed.audio, mimeType: 'audio/pcm;rate=16000' }
          });
        }
        if (parsed.text) {
          session.sendRealtimeInput({
             text: parsed.text
          });
        }
      } catch (err) {
        console.error('Error handling WS message', err);
      }
    });

    clientWs.on('close', () => {
      console.log('Client WS closed');
      try {
        if (session) {
          session.close();
        }
      } catch(e) {}
    });
  });

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
