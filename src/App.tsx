import React, { useState, useEffect, useRef, useCallback } from 'react';
import { pcmToBase64, base64ToFloat32Array } from './lib/audio';
import { Mic, MicOff, Power, Globe, Smartphone, Search, Phone, LogIn, LogOut } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { auth, db } from './firebase';
import { signInWithPopup, GoogleAuthProvider, onAuthStateChanged, User, signOut } from 'firebase/auth';
import { collection, doc, setDoc, onSnapshot, query, orderBy, limit } from 'firebase/firestore';
import { OperationType, handleFirestoreError } from './lib/firestore-errors';

import AdminPanel from './components/AdminPanel';

type SessionState = 'disconnected' | 'connecting' | 'listening' | 'speaking';

interface ToolAction {
  id: string;
  name: string;
  argSummary: string;
  timestamp: number;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'zoya';
  text: string;
  timestamp: number;
}

export default function App() {
  const [sessionState, setSessionState] = useState<SessionState>('disconnected');
  const [recentActions, setRecentActions] = useState<ToolAction[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [contactRequested, setContactRequested] = useState(false);
  const [appLaunchToast, setAppLaunchToast] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  
  const wsRef = useRef<WebSocket | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const captureAudioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  
  // Use generic timeout type
  const stateTimeoutRef = useRef<any>(null);

  const stopAudio = useCallback(() => {
    activeSourcesRef.current.forEach(source => {
      try { source.stop(); } catch(e) {}
    });
    activeSourcesRef.current = [];
    nextStartTimeRef.current = 0;
  }, []);

  const playAudioChunk = useCallback((base64: string) => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    
    // We are receiving audio chunks so we are speaking
    setSessionState('speaking');
    
    // Clear the timeout that reverts to listening
    if (stateTimeoutRef.current) {
      clearTimeout(stateTimeoutRef.current);
    }
    
    // Set a timeout to revert to listening if no more audio arrives
    stateTimeoutRef.current = setTimeout(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
         setSessionState('listening');
      }
    }, 1000);

    const float32Array = base64ToFloat32Array(base64);
    const audioBuffer = ctx.createBuffer(1, float32Array.length, 24000);
    audioBuffer.getChannelData(0).set(float32Array);
    
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    
    if (nextStartTimeRef.current < ctx.currentTime + 0.05) {
      nextStartTimeRef.current = ctx.currentTime + 0.05;
    }
    
    source.start(nextStartTimeRef.current);
    nextStartTimeRef.current += audioBuffer.duration;
    
    activeSourcesRef.current.push(source);
    source.onended = () => {
      activeSourcesRef.current = activeSourcesRef.current.filter(s => s !== source);
    };
  }, []);

  const recognitionRef = useRef<any>(null);

  const startSession = async () => {
    try {
      setErrorMsg(null);
      setSessionState('connecting');
      stopAudio();
      
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}`);
      wsRef.current = ws;

      let micReady = false;
      let wsReady = ws.readyState === WebSocket.OPEN;

      const checkListening = () => {
        if (micReady && wsReady) {
          setSessionState('listening');
        }
      };

      ws.onopen = () => {
        wsReady = true;
        checkListening();
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.audio) {
          playAudioChunk(msg.audio);
        }
        if (msg.text && msg.isZoya) {
          setMessages(prev => [...prev, {
            id: Math.random().toString(36).substr(2, 9),
            role: 'zoya',
            text: msg.text,
            timestamp: Date.now()
          }].slice(-50));
        }
        if (msg.interrupted) {
          stopAudio();
          setSessionState('listening');
        }
        if (msg.action) {
          let argSummary = "";
          
          if (msg.action === "openWebsite" && msg.args.url) {
            argSummary = msg.args.url;
            const url = msg.args.url.startsWith('http') ? msg.args.url : `https://${msg.args.url}`;
            window.open(url, '_blank');
          }
          else if (msg.action === "openInstalledApp" && msg.args.appName) {
            argSummary = msg.args.appName;
            const appNameLower = msg.args.appName.toLowerCase();
            let uri = '';
            let fallbackUrl = `https://www.google.com/search?q=${encodeURIComponent(appNameLower + ' site')}`;
            const isAndroid = /Android/i.test(navigator.userAgent);
            
            setAppLaunchToast(`Launching ${msg.args.appName}...`);
            setTimeout(() => setAppLaunchToast(null), 3000);

            let androidPackage = '';
            let schemeUri = '';

            if (appNameLower.includes('instagram')) { schemeUri = 'instagram://app'; androidPackage = 'com.instagram.android'; fallbackUrl = 'https://instagram.com'; }
            else if (appNameLower.includes('youtube')) { schemeUri = 'vnd.youtube://'; androidPackage = 'com.google.android.youtube'; fallbackUrl = 'https://youtube.com'; }
            else if (appNameLower.includes('whatsapp')) { schemeUri = 'whatsapp://send'; androidPackage = 'com.whatsapp'; fallbackUrl = 'https://web.whatsapp.com'; }
            else if (appNameLower.includes('map')) { schemeUri = 'geo:0,0?q='; androidPackage = 'com.google.android.apps.maps'; fallbackUrl = 'https://maps.google.com'; }
            else if (appNameLower.includes('facebook')) { schemeUri = 'fb://'; androidPackage = 'com.facebook.katana'; fallbackUrl = 'https://facebook.com'; }
            else if (appNameLower.includes('twitter') || appNameLower.includes('x')) { schemeUri = 'twitter://'; androidPackage = 'com.twitter.android'; fallbackUrl = 'https://x.com'; }
            else if (appNameLower.includes('spotify')) { schemeUri = 'spotify://'; androidPackage = 'com.spotify.music'; fallbackUrl = 'https://open.spotify.com'; }
            else if (appNameLower.includes('amazon')) { schemeUri = 'amazon://'; androidPackage = 'com.amazon.mShop.android.shopping'; fallbackUrl = 'https://amazon.com'; }
            else if (appNameLower.includes('netflix')) { schemeUri = 'nflx://'; androidPackage = 'com.netflix.mediaclient'; fallbackUrl = 'https://netflix.com'; }
            else if (appNameLower.includes('flipkart')) { schemeUri = 'flipkart://'; androidPackage = 'com.flipkart.android'; fallbackUrl = 'https://flipkart.com'; }
            else if (appNameLower.includes('telegram')) { schemeUri = 'tg://'; androidPackage = 'org.telegram.messenger'; fallbackUrl = 'https://web.telegram.org'; }
            else if (appNameLower.includes('snapchat')) { schemeUri = 'snapchat://'; androidPackage = 'com.snapchat.android'; fallbackUrl = 'https://snapchat.com'; }
            else if (appNameLower.includes('linkedin')) { schemeUri = 'linkedin://'; androidPackage = 'com.linkedin.android'; fallbackUrl = 'https://linkedin.com'; }
            else if (appNameLower.includes('tiktok')) { schemeUri = 'snssdk1233://'; androidPackage = 'com.zhiliaoapp.musically'; fallbackUrl = 'https://tiktok.com'; }
            else if (appNameLower.includes('gmail')) { schemeUri = 'googlegmail://'; androidPackage = 'com.google.android.gm'; fallbackUrl = 'https://mail.google.com'; }

            if (schemeUri) {
              if (isAndroid && androidPackage) {
                const intentUrl = `intent://#Intent;package=${androidPackage};scheme=${schemeUri.split('://')[0]};S.browser_fallback_url=${encodeURIComponent(fallbackUrl)};end;`;
                window.location.href = intentUrl;
              } else {
                const start = Date.now();
                window.location.href = schemeUri;
                setTimeout(() => {
                  if (Date.now() - start < 2000 && !document.hidden) {
                    window.open(fallbackUrl, '_blank');
                  }
                }, 1500);
              }
            } else {
              window.open(fallbackUrl, '_blank');
            }
          }
          else if (msg.action === "searchWeb" && msg.args.query) {
            argSummary = msg.args.query;
            window.open(`https://www.google.com/search?q=${encodeURIComponent(msg.args.query)}`, '_blank');
          }
          else if (msg.action === "makeNativeCall" && msg.args.contactName) {
            argSummary = `Calling ${msg.args.contactName}`;
            // If they have a native wrapper intercepting 'zoya' scheme or standard 'tel' with a search intent
            try {
              if ((window as any).AndroidNative) ((window as any).AndroidNative).makeCall(msg.args.contactName);
              else window.location.href = `intent://call?name=${encodeURIComponent(msg.args.contactName)}#Intent;scheme=zoya;package=com.aistudio.zoya;end;`;
            } catch (e) {}
          }
          else if (msg.action === "openCameraNative") {
            argSummary = "Opening Camera";
            try {
              if ((window as any).AndroidNative) ((window as any).AndroidNative).openCamera();
              else window.location.href = `intent://#Intent;action=android.media.action.IMAGE_CAPTURE;end;`;
            } catch (e) {}
          }
          else if (msg.action === "openGalleryNative") {
            argSummary = "Opening Gallery";
            try {
              if ((window as any).AndroidNative) ((window as any).AndroidNative).openGallery();
              else window.location.href = `intent://#Intent;action=android.intent.action.VIEW;type=image/*;end;`;
            } catch (e) {}
          }
          else if (msg.action === "sendWhatsAppMessage" && msg.args.contactName) {
            argSummary = `Sending WhatsApp to ${msg.args.contactName}`;
            try {
              if ((window as any).AndroidNative) ((window as any).AndroidNative).sendWhatsApp(msg.args.contactName);
              else window.location.href = `intent://whatsapp?name=${encodeURIComponent(msg.args.contactName)}#Intent;scheme=zoya;package=com.whatsapp;end;`;
            } catch (e) {}
          }
          else if (msg.action === "requestContact") {
            argSummary = "Waiting for user to select contact";
            setContactRequested(true);
          }
          
          const newAction = {
            id: Math.random().toString(36).substr(2, 9),
            name: msg.action,
            argSummary,
            timestamp: Date.now()
          };
          
          setRecentActions(prev => [newAction, ...prev].slice(0, 5));

          if (auth.currentUser) {
            try {
              setDoc(doc(db, `users/${auth.currentUser.uid}/actions`, newAction.id), newAction)
                .catch(err => handleFirestoreError(err, OperationType.CREATE, `users/${auth.currentUser.uid}/actions/${newAction.id}`));
            } catch (err) {}
          }
        }
      };
      
      ws.onclose = () => {
        disconnectSession();
      };
      
      ws.onerror = (e) => {
        console.error("WS Error", e);
        disconnectSession();
      };

      // Setup Web Speech API for user transcription
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = false;
        recognition.lang = 'en-US';
        
        let lastTimestamp = 0;
        recognition.onresult = (event: any) => {
          const result = event.results[event.results.length - 1];
          if (result.isFinal) {
            const text = result[0].transcript.trim();
            if (text && Date.now() - lastTimestamp > 500) {
              lastTimestamp = Date.now();
              setMessages(prev => [...prev, {
                id: Math.random().toString(36).substr(2, 9),
                role: 'user',
                text,
                timestamp: Date.now()
              }].slice(-50));
            }
          }
        };
        recognition.onerror = (e: any) => console.log('Speech rec error:', e);
        try {
          recognition.start();
          recognitionRef.current = recognition;
        } catch (e) {}
      }
      
      // Init Audio contexts if not initialized
      const AudioCtxConstructor = window.AudioContext || (window as any).webkitAudioContext;
      if (!audioCtxRef.current) audioCtxRef.current = new AudioCtxConstructor({ sampleRate: 24000 });
      if (!captureAudioCtxRef.current) captureAudioCtxRef.current = new AudioCtxConstructor({ sampleRate: 16000 });
      
      const resumeAudio = async () => {
        if (audioCtxRef.current?.state === 'suspended') {
          await audioCtxRef.current.resume();
        }
        if (captureAudioCtxRef.current?.state === 'suspended') {
          await captureAudioCtxRef.current.resume();
        }
      };

      const getMic = navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }
      });

      let stream: MediaStream;
      try {
        const [, micStream] = await Promise.all([resumeAudio(), getMic]);
        stream = micStream;
      } catch (err: any) {
        setErrorMsg("Microphone access denied. Please allow microphone permissions or open the app in a new tab.");
        disconnectSession();
        return;
      }

      // If disconnected while waiting for mic (e.g. WS error), bail out
      if (!captureAudioCtxRef.current || wsRef.current !== ws) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }

      streamRef.current = stream;
      const captureCtx = captureAudioCtxRef.current;
      sourceRef.current = captureCtx.createMediaStreamSource(stream);
      processorRef.current = captureCtx.createScriptProcessor(4096, 1, 1);
      
      sourceRef.current.connect(processorRef.current);
      processorRef.current.connect(captureCtx.destination);
      
      processorRef.current.onaudioprocess = (e) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          const float32Array = e.inputBuffer.getChannelData(0);
          const base64 = pcmToBase64(float32Array);
          wsRef.current.send(JSON.stringify({ audio: base64 }));
        }
      };

      micReady = true;
      checkListening();
      
    } catch (err) {
      console.error("Failed to start session:", err);
      disconnectSession();
    }
  };

  const disconnectSession = useCallback(() => {
    stopAudio();
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch(e) {}
      recognitionRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    if (captureAudioCtxRef.current) {
      captureAudioCtxRef.current.close();
      captureAudioCtxRef.current = null;
    }
    setSessionState('disconnected');
    if (stateTimeoutRef.current) {
      clearTimeout(stateTimeoutRef.current);
    }
  }, [stopAudio]);

  useEffect(() => {
    return () => {
      disconnectSession();
    };
  }, [disconnectSession]);

  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        const actionsQuery = query(
          collection(db, `users/${currentUser.uid}/actions`),
          orderBy('timestamp', 'desc'),
          limit(5)
        );
        return onSnapshot(actionsQuery, (snapshot) => {
          if (!snapshot.empty) {
             const actions = snapshot.docs.map(doc => doc.data() as ToolAction);
             setRecentActions(actions);
          }
        }, (error) => {
          handleFirestoreError(error, OperationType.LIST, `users/${currentUser.uid}/actions`);
        });
      } else {
        setRecentActions([]);
      }
    });
    return () => unsubscribeAuth();
  }, []);

  const handleLogin = async () => {
    try {
      if (window !== window.top) {
        setErrorMsg("Signing in requires opening the app in a new tab.");
        return;
      }
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (err: any) {
      console.error('Login failed', err);
      if (err?.code === 'auth/popup-closed-by-user') {
        setErrorMsg("Sign in popup was closed. Please try again.");
      } else {
        setErrorMsg("Failed to sign in.");
      }
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } catch (err) {}
  };

  const handleContactPick = async () => {
    if (window !== window.top) {
      setErrorMsg("Contact picking requires opening the app in a new tab.");
      wsRef.current?.send(JSON.stringify({ text: `I'm embedded in a preview frame so I can't open your contacts. Please open me in a new tab, or just tell me the number.` }));
      setContactRequested(false);
      return;
    }

    if ('contacts' in navigator && 'ContactsManager' in window) {
      try {
        const props = ['name', 'tel'];
        const opts = { multiple: false };
        const contacts = await (navigator as any).contacts.select(props, opts);
        if (contacts.length > 0) {
          const contact = contacts[0];
          const name = contact.name?.[0] || 'Unknown';
          const tel = contact.tel?.[0] || 'Unknown';
          wsRef.current?.send(JSON.stringify({ text: `I selected the contact ${name}. Their number is ${tel}. Call them now.` }));
        }
      } catch (ex) {
        console.error("Contact API error", ex);
        wsRef.current?.send(JSON.stringify({ text: `Failed to open contact list. Tell me to manually dictate the number.` }));
      }
    } else {
      setErrorMsg("Contact picking is not fully supported on this device/browser.");
      wsRef.current?.send(JSON.stringify({ text: `My phone doesn't support automatic contact picking. Please ask me to say the number aloud.` }));
    }
    setContactRequested(false);
  };

  const renderParticles = () => {
    if (sessionState !== 'listening' && sessionState !== 'speaking') return null;
    return (
      <div className="absolute inset-0 overflow-hidden pointer-events-none opacity-40">
        {[...Array(12)].map((_, i) => (
          <motion.div
            key={i}
            className={`absolute w-1.5 h-1.5 rounded-full ${sessionState === 'speaking' ? 'bg-pink-400' : 'bg-cyan-400'}`}
            initial={{ 
              x: "50%", y: "50%", opacity: 0 
            }}
            animate={{
              x: ["50%", `${50 + (Math.random() * 100 - 50)}%`],
              y: ["50%", `${50 + (Math.random() * 100 - 50)}%`],
              opacity: [0, 0.8, 0],
              scale: [0.5, 1.5, 0.5]
            }}
            transition={{
              duration: 2 + Math.random() * 2,
              repeat: Infinity,
              ease: "easeInOut",
              delay: Math.random() * 2
            }}
          />
        ))}
      </div>
    );
  };

  const getActionIcon = (actionName: string) => {
    switch (actionName) {
      case 'openWebsite': return <Globe size={18} />;
      case 'openApp': return <Smartphone size={18} />;
      case 'searchWeb': return <Search size={18} />;
      case 'makeCall': return <Phone size={18} />;
      default: return <Power size={18} />;
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-white flex flex-col items-center justify-between p-4 font-sans selection:bg-pink-500/30">
      
      {/* Header and Story-like Auth */}
      <div className="w-full pt-4 px-4 flex flex-col items-center">
        <div className="w-full flex justify-between items-center mb-6">
          <div className="flex-1"></div>
          <div className="text-center flex-1">
            <h1 className="text-2xl font-semibold tracking-tighter text-transparent bg-clip-text bg-gradient-to-r from-pink-400 via-purple-400 to-cyan-400">
              Zoya AI
            </h1>
            <p className="text-[#1bfc52] font-bold text-[10px] mt-0.5 tracking-wide uppercase">
              Voice Assistant
            </p>
          </div>
          <div className="flex-1 flex justify-end">
            {user ? (
              <button onClick={handleLogout} className="flex flex-col items-center space-y-1 hover:opacity-80 transition-opacity">
                <div className="relative">
                  <div className="w-12 h-12 rounded-full p-[2px] bg-gradient-to-tr from-yellow-400 via-pink-500 to-purple-500">
                    <img src={user.photoURL || ''} alt="avatar" className="w-full h-full rounded-full border-2 border-neutral-950 object-cover" />
                  </div>
                </div>
                <span className="text-[10px] text-neutral-400 font-medium truncate max-w-[60px]">
                  {user.email === 'ku635465002@gmail.com' ? 'Owner' : user.displayName?.split(' ')[0] || 'You'}
                </span>
              </button>
            ) : (
              <button onClick={handleLogin} className="flex flex-col items-center space-y-1 hover:opacity-80 transition-opacity">
                <div className="w-12 h-12 rounded-full p-[2px] bg-neutral-800">
                  <div className="w-full h-full rounded-full border-2 border-neutral-950 bg-neutral-900 flex items-center justify-center">
                     <LogIn size={20} className="text-neutral-500" />
                  </div>
                </div>
                <span className="text-[10px] text-neutral-400 font-medium">Login</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Chat Bubbles Interface */}
      <div className="w-full max-w-md flex-1 overflow-y-auto px-4 mt-2 space-y-4 custom-scrollbar min-h-[150px] max-h-[30vh]">
        <AnimatePresence initial={false}>
          {messages.map((m) => (
            <motion.div
              key={m.id}
              initial={{ opacity: 0, y: 10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              className={`flex w-full ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div className={`
                max-w-[80%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap
                ${m.role === 'user' ? 'bg-cyan-900/60 text-cyan-50 border border-cyan-700/50 rounded-br-sm' : 'bg-pink-900/40 text-pink-50 border border-pink-700/30 rounded-bl-sm'}
              `}>
                {m.text}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {errorMsg && (
        <div className="w-full max-w-md mt-4 px-4 z-50">
          <div className="bg-red-950/50 border border-red-500/50 text-red-200 text-sm p-3 rounded-xl text-center relative flex justify-between items-center">
            <span>{errorMsg}</span>
            <button onClick={() => setErrorMsg(null)} className="opacity-50 hover:opacity-100 ml-2">×</button>
          </div>
        </div>
      )}

      {contactRequested && (
        <motion.div 
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-md mt-4 px-4 z-50"
        >
          <div className="bg-neutral-900 border border-cyan-500/50 text-white rounded-2xl p-4 shadow-xl flex justify-between items-center">
            <div className="text-sm">
              <p className="font-semibold text-cyan-400">Zoya needs a contact</p>
              <p className="text-neutral-400 text-xs">Please select who to call</p>
            </div>
            <div className="flex space-x-2">
              <button 
                onClick={() => {
                   setContactRequested(false);
                   wsRef.current?.send(JSON.stringify({ text: `I cancelled the contact picking.` }));
                }}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-neutral-800 text-neutral-400 border border-neutral-700"
              >
                Cancel
              </button>
              <button 
                onClick={handleContactPick}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-cyan-500 text-neutral-950 flex items-center space-x-1"
              >
                <Smartphone size={14} />
                <span>Select Contact</span>
              </button>
            </div>
          </div>
        </motion.div>
      )}

      <AnimatePresence>
        {appLaunchToast && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="absolute top-1/4 z-50 px-6 py-3 rounded-full bg-pink-500/20 border border-pink-500/50 backdrop-blur-md shadow-[0_0_20px_-5px_rgba(236,72,153,0.3)] flex items-center space-x-2"
          >
            <Smartphone size={16} className="text-pink-400" />
            <span className="text-pink-100 text-sm font-medium">{appLaunchToast}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main interaction center */}
      <div className="flex-1 flex flex-col items-center justify-center w-full relative">
        {renderParticles()}
        
        <div className="relative z-10 flex items-center justify-center h-64 w-64">
          {sessionState === 'speaking' && (
            <motion.div 
              className="absolute inset-0 rounded-full border border-pink-500/50 mix-blend-screen"
              animate={{
                scale: [1, 1.3, 1],
                opacity: [0.2, 0.6, 0.2]
              }}
              transition={{ repeat: Infinity, duration: 1.5, ease: "easeInOut" }}
            />
          )}

          {sessionState === 'listening' && (
            <motion.div 
              className="absolute inset-0 rounded-full border border-cyan-500/30 mix-blend-screen"
              animate={{
                scale: [1, 1.2, 1],
                opacity: [0.1, 0.3, 0.1]
              }}
              transition={{ repeat: Infinity, duration: 2, ease: "easeInOut" }}
            />
          )}
          
          <button
            onClick={() => sessionState === 'disconnected' ? startSession() : disconnectSession()}
            className={`
              relative flex flex-col items-center justify-center text-[#de2d2d]
              h-40 w-40 rounded-full group outline-none
              transition-all duration-700 ease-in-out cursor-pointer
            `}
          >
            {/* Core Background & Outer Glow */}
            <div className={`
              absolute inset-0 rounded-full transition-all duration-700
              ${sessionState === 'disconnected' 
                 ? 'bg-neutral-950/80 shadow-[inset_0_0_30px_rgba(0,0,0,0.8),0_0_20px_rgba(0,0,0,0.5)] border border-neutral-800/50 group-hover:border-[#de2d2d]/30 group-hover:shadow-[inset_0_0_40px_rgba(222,45,45,0.1)]' 
                 : ''}
              ${sessionState === 'connecting' 
                 ? 'bg-neutral-900/90 shadow-[inset_0_0_40px_rgba(6,182,212,0.1),0_0_30px_rgba(6,182,212,0.2)] border border-cyan-900/50' 
                 : ''}
              ${sessionState === 'listening' 
                 ? 'bg-neutral-950/80 shadow-[inset_0_0_60px_rgba(6,182,212,0.5),0_0_50px_rgba(6,182,212,0.4)] border border-cyan-500/50' 
                 : ''}
              ${sessionState === 'speaking' 
                 ? 'bg-neutral-950/80 shadow-[inset_0_0_60px_rgba(236,72,153,0.5),0_0_50px_rgba(236,72,153,0.4)] border border-pink-500/50' 
                 : ''}
            `} />

            {/* Futuristic Spinning Rings */}
            <motion.div 
              className={`absolute inset-2 rounded-full border border-dashed opacity-40 ${sessionState === 'speaking' ? 'border-pink-500' : sessionState === 'listening' ? 'border-cyan-500' : 'border-[#de2d2d]/50'}`}
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, duration: 10, ease: "linear" }}
            />
            <motion.div 
              className={`absolute inset-5 rounded-full border border-dotted opacity-30 ${sessionState === 'speaking' ? 'border-pink-400' : sessionState === 'listening' ? 'border-cyan-400' : 'border-[#de2d2d]/30'}`}
              animate={{ rotate: -360 }}
              transition={{ repeat: Infinity, duration: 15, ease: "linear" }}
            />
            
            {/* Center Orb for Depth */}
            <div className={`
               absolute w-16 h-16 rounded-full blur-xl transition-all duration-700
               ${sessionState === 'disconnected' ? 'bg-[#de2d2d]/10 group-hover:bg-[#de2d2d]/20' : ''}
               ${sessionState === 'connecting' ? 'bg-cyan-500/20' : ''}
               ${sessionState === 'listening' ? 'bg-cyan-400/40 scale-125' : ''}
               ${sessionState === 'speaking' ? 'bg-pink-400/50 scale-150' : ''}
            `} />

            {/* Inner Icons */}
            <div className="z-10 flex flex-col items-center">
              {sessionState === 'disconnected' && <Power size={38} className="text-[#de2d2d] drop-shadow-[0_0_8px_rgba(222,45,45,0.7)] group-hover:drop-shadow-[0_0_15px_rgba(222,45,45,1)] transition-all duration-300" />}
              {sessionState === 'connecting' && (
                 <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 2, ease: "linear" }}>
                   <Power size={38} className="text-cyan-500 drop-shadow-[0_0_8px_rgba(6,182,212,0.8)]" />
                 </motion.div>
              )}
              {sessionState === 'listening' && <Mic size={38} className="text-cyan-300 drop-shadow-[0_0_12px_rgba(103,232,249,0.8)]" />}
              {sessionState === 'speaking' && <Mic size={38} className="text-pink-300 drop-shadow-[0_0_12px_rgba(244,114,182,0.8)]" />}
            </div>
          </button>
        </div>

        {/* Status text */}
        <div className="h-10 mt-8 flex items-center justify-center">
          <AnimatePresence mode="wait">
             <motion.div
               key={sessionState}
               initial={{ opacity: 0, y: 10 }}
               animate={{ opacity: 1, y: 0 }}
               exit={{ opacity: 0, y: -10 }}
               className="text-[#2bcb43] font-bold text-sm tracking-wide bg-neutral-900/50 px-4 py-1.5 rounded-full border border-neutral-800/80 backdrop-blur-sm"
             >
               {sessionState === 'disconnected' && 'Tap to start session'}
               {sessionState === 'connecting' && 'Waking up Zoya...'}
               {sessionState === 'listening' && 'Listening...'}
               {sessionState === 'speaking' && 'Speaking...'}
             </motion.div>
          </AnimatePresence>
        </div>
      </div>

      {/* Tool Events Panel */}
      <div className="w-full max-w-md pb-8 px-6 text-left">
          <h3 className="text-xs font-medium text-neutral-600 uppercase tracking-widest mb-3">Live Actions</h3>
          <div className="space-y-2 h-32 overflow-hidden flex flex-col justify-end relative">
             <AnimatePresence initial={false}>
                {recentActions.length === 0 && (
                   <motion.div 
                     initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                     className="text-neutral-700 text-sm h-full flex items-center pt-10"
                   >
                     No smart actions triggered yet. Give Zoya a command.
                   </motion.div>
                )}
                {recentActions.map((action, i) => (
                  <motion.div
                    key={action.id}
                    initial={{ opacity: 0, y: 20, height: 0 }}
                    animate={{ opacity: 1 - (i * 0.25), y: 0, height: 'auto' }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={{ duration: 0.3 }}
                    className="flex flex-row items-center space-x-3 bg-neutral-900/40 border border-neutral-800/60 p-3 rounded-2xl backdrop-blur-sm"
                  >
                    <div className="bg-neutral-800 text-pink-400 p-2 rounded-xl shrink-0 border border-neutral-700/50">
                       {getActionIcon(action.name)}
                    </div>
                    <div className="flex-1 overflow-hidden">
                       <p className="text-sm text-neutral-200 font-medium truncate">
                         {action.name.replace(/([A-Z])/g, ' $1').trim().replace(/^./, str => str.toUpperCase())}
                       </p>
                       {action.argSummary && (
                         <p className="text-xs text-neutral-500 truncate">{action.argSummary}</p>
                       )}
                    </div>
                  </motion.div>
                ))}
             </AnimatePresence>
             {/* Fade overlay at top of list */}
             <div className="absolute top-0 left-0 w-full h-8 bg-gradient-to-b from-neutral-950 to-transparent pointer-events-none" />
          </div>
      </div>
      
      {/* Admin Control Panel */}
      {user?.email === 'ku635465002@gmail.com' && (
        <div className="w-full max-w-md pb-8 px-6 flex justify-center">
          <AdminPanel />
        </div>
      )}

    </div>
  );
}

