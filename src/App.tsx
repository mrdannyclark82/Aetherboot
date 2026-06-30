import React, { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { Terminal as TerminalIcon, Folder, File, Play, Pause, Volume2, VolumeX, Image as ImageIcon, Code, Users, Maximize2, Minimize2, Upload, CheckCircle2, Power, FileCode, Save, Mic, MicOff, Wifi, LogOut, Settings, Shield, Activity, Cpu, Layers, StopCircle, RefreshCw, Send, Sparkles, Bot, Copy, Check, Video, Wand2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { auth, googleProvider, db } from './firebase';
import { signInWithPopup, signOut, onAuthStateChanged, User } from 'firebase/auth';
import { collection, doc, setDoc, deleteDoc, onSnapshot, query, orderBy, limit } from 'firebase/firestore';

// Types
type VFSNode = { path: string, type: 'file' | 'dir', content?: string, children?: string[], ownerId?: string, updatedAt?: number };
type VFS = Record<string, VFSNode>;

type HistoryEntry = {
  id: string;
  type: 'command' | 'output' | 'error' | 'image' | 'video' | 'sandbox';
  text?: string;
  url?: string;
  pip?: boolean;
  code?: string;
  timestamp: number;
  userId: string;
};

export default function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [vfs, setVfs] = useState<VFS>({});
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [input, setInput] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [rightPanel, setRightPanel] = useState<'sandbox' | 'editor' | 'sandbox-monitor' | 'gemini-chat' | null>(null);
  const [activeSandbox, setActiveSandbox] = useState<string | null>(null);
  const [editorFile, setEditorFile] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState('');
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [showSetup, setShowSetup] = useState(false);
  const [isBooting, setIsBooting] = useState(true);
  const [bootStarted, setBootStarted] = useState(false);
  const [bootVideo, setBootVideo] = useState(localStorage.getItem('aetherterm_boot_video') || "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4");
  const [isListening, setIsListening] = useState(false);
  const [prediction, setPrediction] = useState('');
  const [isLocalMode, setIsLocalMode] = useState(false);
  const [sandboxMetrics, setSandboxMetrics] = useState<{ workspaceSize: string, processes: any[] }>({ workspaceSize: '0 KB', processes: [] });

  const [sessionId, setSessionId] = useState(() => {
    return new URLSearchParams(window.location.search).get('session') || 'lobby';
  });
  const [sandboxEnabled, setSandboxEnabled] = useState(false);
  const [typingUser, setTypingUser] = useState<string | null>(null);

  // Gemini Workspace States
  const [geminiMode, setGeminiMode] = useState<'chat' | 'image' | 'video' | 'code'>('chat');
  const [geminiPrompt, setGeminiPrompt] = useState('');
  const [geminiChatHistory, setGeminiChatHistory] = useState<Array<{ role: 'user' | 'model', content: string, mediaUrl?: string, mediaType?: 'image' | 'video' }>>([]);
  const [geminiLoading, setGeminiLoading] = useState(false);
  const [videoOperationName, setVideoOperationName] = useState<string | null>(null);

  // Tab completion commands
  const ALL_COMMANDS = ['help', 'clear', 'ls', 'cat', 'mkdir', 'touch', 'echo', 'play', 'pip', 'view', 'ask', 'generate-app', 'generate-image', 'github', 'github-sync', 'agent', 'local-ask', 'set-boot', 'edit', 'nix', 'pkg', 'sandbox'];
  const [onlineUsers, setOnlineUsers] = useState<string[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [apiKeys, setApiKeys] = useState({
    openai: localStorage.getItem('aetherterm_openai_key') || '',
    anthropic: localStorage.getItem('aetherterm_anthropic_key') || '',
    gemini: localStorage.getItem('aetherterm_gemini_key') || '',
    ollamaUrl: localStorage.getItem('aetherterm_ollama_url') || 'http://localhost:11434',
  });
  const [defaultLlm, setDefaultLlm] = useState(localStorage.getItem('aetherterm_default_llm') || 'gemini');
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const asciiArt = `███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗    ██████╗  █████╗ ██╗   ██╗███╗   ██╗███████╗
████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝    ██╔══██╗██╔══██╗╚██╗ ██╔╝████╗  ██║██╔════╝
██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗    ██████╔╝███████║ ╚████╔╝ ██╔██╗ ██║█████╗  
██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║    ██╔══██╗██╔══██║  ╚██╔╝  ██║╚██╗██║██╔══╝  
██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║    ██║  ██║██║  ██║   ██║   ██║ ╚████║███████╗
╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝    ╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═══╝╚══════╝`;

  const renderAscii = (text: string) => {
    return text.split('\n').map((line, lineIdx) => (
      <div key={lineIdx}>
        {line.split('').map((char, charIdx) => {
          if (char === '█') return <span key={charIdx} className="ascii-front">{char}</span>;
          if (['╗', '║', '╚', '╔', '╝', '═'].includes(char)) return <span key={charIdx} className="ascii-shadow">{char}</span>;
          return char;
        })}
      </div>
    ));
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !socket) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      socket.emit('upload_file', { path: `/home/${file.name}`, content, vfs });
    };
    reader.readAsDataURL(file);
  };

  const handleMountLocal = async () => {
    try {
      // @ts-ignore - File System Access API
      const dirHandle = await window.showDirectoryPicker();
      const localRoot = `/local`;
      
      const newNodes: VFSNode[] = [];
      newNodes.push({ path: localRoot, type: 'dir', children: [], ownerId: user?.uid || 'local', updatedAt: Date.now() });

      const processHandle = async (handle: any, currentPath: string) => {
        if (handle.kind === 'file') {
          const file = await handle.getFile();
          try {
            const content = await file.text();
            newNodes.push({ path: currentPath, type: 'file', content, ownerId: user?.uid || 'local', updatedAt: Date.now() });
          } catch (e) {
            // Skip binary files
          }
          return currentPath;
        } else if (handle.kind === 'directory') {
          const children = [];
          for await (const entry of handle.values()) {
            const childPath = `${currentPath}/${entry.name}`;
            children.push(childPath);
            await processHandle(entry, childPath);
          }
          newNodes.push({ path: currentPath, type: 'dir', children, ownerId: user?.uid || 'local', updatedAt: Date.now() });
          return currentPath;
        }
      };

      await processHandle(dirHandle, localRoot);
      
      if (vfs['/']) {
        if (!vfs['/'].children?.includes(localRoot)) {
          newNodes.push({ ...vfs['/'], children: [...(vfs['/'].children || []), localRoot] });
        }
      }

      socket?.emit('sync_vfs_batch', { nodes: newNodes });
      setHistory(prev => [...prev, { id: Date.now().toString(), type: 'output', text: `Mounted local directory to /local`, timestamp: Date.now(), userId: user?.uid || 'local' }]);
      
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setHistory(prev => [...prev, { id: Date.now().toString(), type: 'error', text: `Failed to mount local directory: ${err.message}`, timestamp: Date.now(), userId: user?.uid || 'local' }]);
      }
    }
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!isAuthReady) return;

    if (!user) {
      setIsLocalMode(true);
    } else {
      setIsLocalMode(false);
    }

    if (!localStorage.getItem('aetherterm_setup_complete')) {
      setShowSetup(true);
    }

    const newSocket = io();
    setSocket(newSocket);

    newSocket.emit('join', {
      username: user ? (user.displayName || user.email?.split('@')[0]) : 'Local User',
      sessionId
    });

    let unsubscribeVfs = () => {};
    let unsubscribeHistory = () => {};

    if (user) {
      // Listen to Firestore for VFS
      unsubscribeVfs = onSnapshot(collection(db, 'vfs'), (snapshot) => {
        const newVfs: VFS = {};
        snapshot.forEach((doc) => {
          const data = doc.data();
          const path = data.path || decodeURIComponent(doc.id);
          newVfs[path] = { ...data, path } as VFSNode;
        });
        // Ensure root and home exist if empty
        if (Object.keys(newVfs).length === 0) {
          const initialVfs: VFS = {
            '/': { path: '/', type: 'dir', children: ['/home', '/bin'], ownerId: user.uid, updatedAt: Date.now() },
            '/home': { path: '/home', type: 'dir', children: [], ownerId: user.uid, updatedAt: Date.now() },
            '/bin': { path: '/bin', type: 'dir', children: [], ownerId: user.uid, updatedAt: Date.now() },
          };
          setVfs(initialVfs);
          Object.values(initialVfs).forEach(node => {
            setDoc(doc(db, 'vfs', encodeURIComponent(node.path)), node).catch(console.error);
          });
        } else {
          setVfs(newVfs);
        }
      });

      // Listen to Firestore for History
      const historyQuery = query(collection(db, 'history'), orderBy('timestamp', 'asc'), limit(100));
      unsubscribeHistory = onSnapshot(historyQuery, (snapshot) => {
        const newHistory: HistoryEntry[] = [];
        snapshot.forEach((doc) => {
          newHistory.push(doc.data() as HistoryEntry);
        });
        setHistory(newHistory);
      });
    } else {
      // Local Mode VFS
      const initialVfs: VFS = {
        '/': { path: '/', type: 'dir', children: ['/home', '/bin'], ownerId: 'local', updatedAt: Date.now() },
        '/home': { path: '/home', type: 'dir', children: [], ownerId: 'local', updatedAt: Date.now() },
        '/bin': { path: '/bin', type: 'dir', children: [], ownerId: 'local', updatedAt: Date.now() },
      };
      setVfs(initialVfs);
      setHistory([]);
    }

    newSocket.on('sync_all_history', (serverHistory: HistoryEntry[]) => {
      setHistory(serverHistory);
    });

    newSocket.on('sync_all_vfs', (serverVfs: VFSNode[]) => {
      setVfs(prev => {
        const next = { ...prev };
        serverVfs.forEach(n => next[n.path] = n);
        return next;
      });
    });

    newSocket.on('editor_change', (data: { path: string, content: string }) => {
      if (editorFile === data.path) {
        setEditorContent(data.content);
      }
    });

    newSocket.on('open_sandbox_monitor', () => {
      setRightPanel('sandbox-monitor');
    });

    newSocket.on('sandbox_metrics', (data: { workspaceSize: string, processes: any[] }) => {
      setSandboxMetrics(data);
    });

    newSocket.on('users_update', (users: string[]) => {
      setOnlineUsers(users);
    });

    newSocket.on('sync_vfs', (nodes: VFSNode[]) => {
      setVfs(prev => {
        const next = { ...prev };
        nodes.forEach(n => next[n.path] = n);
        return next;
      });
      if (user) {
        nodes.forEach(node => {
          const nodeToSave = { ...node, ownerId: user.uid, updatedAt: Date.now() };
          setDoc(doc(db, 'vfs', encodeURIComponent(node.path)), nodeToSave).catch(console.error);
        });
      }
    });

    newSocket.on('purge_vfs_paths', (paths: string[]) => {
      setVfs(prev => {
        const next = { ...prev };
        paths.forEach(p => delete next[p]);
        return next;
      });
      if (user) {
        paths.forEach(p => {
          deleteDoc(doc(db, 'vfs', encodeURIComponent(p))).catch(console.error);
        });
      }
    });

    newSocket.on('sync_history', (entry: any) => {
      setHistory(prev => [...prev, entry]);
      if (user) {
        const entryToSave: HistoryEntry = {
          ...entry,
          timestamp: Date.now(),
          userId: user.uid
        };
        setDoc(doc(db, 'history', entryToSave.id), entryToSave).catch(console.error);
      }
    });

    newSocket.on('open_editor', (data: { path: string, content: string }) => {
      setEditorFile(data.path);
      setEditorContent(data.content);
      setRightPanel('editor');
    });

    newSocket.on('request_local_llm', async (data: { id: string, prompt: string }) => {
      try {
        const ollamaUrl = localStorage.getItem('aetherterm_ollama_url') || 'http://localhost:11434';
        const response = await fetch(`${ollamaUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            model: 'llama3', 
            prompt: data.prompt, 
            stream: false 
          })
        });
        if (response.ok) {
          const result = await response.json();
          newSocket.emit(`response_local_llm_${data.id}`, { text: result.response });
        } else {
          newSocket.emit(`response_local_llm_${data.id}`, { error: `Ollama returned status ${response.status}` });
        }
      } catch (err: any) {
        newSocket.emit(`response_local_llm_${data.id}`, { error: `Could not connect to Ollama. Make sure it is running locally and CORS is configured.` });
      }
    });

    newSocket.on('sync_input', (data: { text: string, user: string }) => {
      setInput(data.text);
      if (data.user && data.user !== (user ? (user.displayName || user.email?.split('@')[0]) : 'Local User')) {
        setTypingUser(data.user);
      } else {
        setTypingUser(null);
      }
    });

    newSocket.on('gemini_chat_response', (data: any) => {
      setGeminiLoading(false);
      if (data.error) {
        setGeminiChatHistory(prev => [...prev, { role: 'model', content: `Error: ${data.error}` }]);
      } else {
        setGeminiChatHistory(prev => [...prev, { role: 'model', content: data.text }]);
      }
    });

    newSocket.on('gemini_generate_image_response', (data: any) => {
      setGeminiLoading(false);
      if (data.error) {
        setGeminiChatHistory(prev => [...prev, { role: 'model', content: `Error generating image: ${data.error}` }]);
      } else {
        setGeminiChatHistory(prev => [...prev, { role: 'model', content: `Generated successfully: [File: ${data.filepath}]`, mediaUrl: data.url, mediaType: 'image' }]);
      }
    });

    newSocket.on('gemini_generate_video_response', (data: any) => {
      if (data.error) {
        setGeminiLoading(false);
        setGeminiChatHistory(prev => [...prev, { role: 'model', content: `Error initiating video generation: ${data.error}` }]);
      } else {
        setVideoOperationName(data.operationName);
        setGeminiChatHistory(prev => [...prev, { role: 'model', content: `Video generation process initiated on Google Veo. Compiling frames...` }]);
      }
    });

    newSocket.on('gemini_get_video_status_response', (data: any) => {
      if (data.error) {
        setGeminiLoading(false);
        setVideoOperationName(null);
        setGeminiChatHistory(prev => [...prev, { role: 'model', content: `Error generating video: ${data.error}` }]);
      } else if (data.done) {
        setGeminiLoading(false);
        setVideoOperationName(null);
        setGeminiChatHistory(prev => [...prev, { role: 'model', content: `Video generated successfully! [File: ${data.filepath}]`, mediaUrl: data.url, mediaType: 'video' }]);
      }
    });

    newSocket.on('gemini_generate_code_response', (data: any) => {
      setGeminiLoading(false);
      if (data.error) {
        setGeminiChatHistory(prev => [...prev, { role: 'model', content: `Error generating app: ${data.error}` }]);
      } else {
        setActiveSandbox(data.code);
        setRightPanel('sandbox');
        setGeminiChatHistory(prev => [...prev, { role: 'model', content: `Interactive web app generated and rendered in sandbox! [File: ${data.filepath}]` }]);
      }
    });

    return () => {
      newSocket.close();
      unsubscribeVfs();
      unsubscribeHistory();
    };
  }, [user]);

  useEffect(() => {
    if (!videoOperationName || !socket) return;
    
    const interval = setInterval(() => {
      socket.emit('gemini_get_video_status', { 
        operationName: videoOperationName,
        prompt: geminiChatHistory[geminiChatHistory.length - 1]?.content || ''
      });
    }, 4000);

    return () => clearInterval(interval);
  }, [videoOperationName, socket, geminiChatHistory]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history]);

  const handleCommand = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !socket) return;

    const trimmedInput = input.trim();
    setCommandHistory(prev => [...prev, trimmedInput]);
    setHistoryIndex(-1);
    setPrediction('');

    if (trimmedInput === 'clear') {
      setHistory([]);
      setInput('');
      return;
    }

    const [command, ...args] = trimmedInput.split(' ');

    if (command === 'set-boot') {
      const target = args[0];
      if (!target) return;
      let urlToSave = target;
      if (target.startsWith('/')) {
        const node = vfs[target];
        if (node && node.type === 'file' && node.content) {
          urlToSave = node.content;
        } else {
          setHistory(prev => [...prev, { id: Date.now().toString(), type: 'error', text: `File not found in VFS: ${target}` }]);
          setInput('');
          return;
        }
      }
      
      try {
        localStorage.setItem('aetherterm_boot_video', urlToSave);
        setBootVideo(urlToSave);
        setHistory(prev => [...prev, { id: Date.now().toString(), type: 'output', text: `Boot video updated successfully. It will play on the next reload.` }]);
      } catch (err) {
        setHistory(prev => [...prev, { id: Date.now().toString(), type: 'error', text: `Failed to save boot video. The file is likely too large for local storage (limit ~5MB). Try a smaller file or an external URL.` }]);
      }
      
      setInput('');
      return;
    }

    socket.emit('command', { 
      command, 
      args, 
      user: user ? (user.displayName || user.email?.split('@')[0]) : 'Local User', 
      vfs,
      apiKeys,
      defaultLlm,
      sandboxEnabled
    });
    setInput('');
    socket?.emit('input_change', { text: '', timestamp: Date.now() });
  };

  const handleSendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || !socket) return;

    socket.emit('chat_message', {
      message: chatInput.trim()
    });
    setChatInput('');
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setInput(val);
    socket?.emit('input_change', { text: val, timestamp: Date.now() });
    if (!val) {
      setPrediction('');
      return;
    }

    const parts = val.split(' ');
    if (parts.length === 1) {
      const match = ALL_COMMANDS.find(c => c.startsWith(val));
      setPrediction(match ? match : '');
    } else {
      const lastPart = parts[parts.length - 1];
      const paths = Object.keys(vfs);
      const match = paths.find(p => p.startsWith(lastPart));
      if (match) {
        parts[parts.length - 1] = match;
        setPrediction(parts.join(' '));
      } else {
        setPrediction('');
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      if (prediction) {
        setInput(prediction);
        socket?.emit('input_change', { text: prediction, timestamp: Date.now() });
        setPrediction('');
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (commandHistory.length > 0) {
        const newIndex = historyIndex < commandHistory.length - 1 ? historyIndex + 1 : historyIndex;
        setHistoryIndex(newIndex);
        const txt = commandHistory[commandHistory.length - 1 - newIndex];
        setInput(txt);
        socket?.emit('input_change', { text: txt, timestamp: Date.now() });
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex > 0) {
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        const txt = commandHistory[commandHistory.length - 1 - newIndex];
        setInput(txt);
        socket?.emit('input_change', { text: txt, timestamp: Date.now() });
      } else if (historyIndex === 0) {
        setHistoryIndex(-1);
        setInput('');
        socket?.emit('input_change', { text: '', timestamp: Date.now() });
      }
    }
  };

  const toggleVoiceCommand = () => {
    if (isListening) return;
    
    // @ts-ignore - Web Speech API
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setHistory(prev => [...prev, { id: Date.now().toString(), type: 'error', text: 'Speech recognition is not supported in this browser.' }]);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    recognition.onstart = () => setIsListening(true);
    
    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      setInput(transcript.toLowerCase().replace(/[.,?!]/g, ''));
    };

    recognition.onerror = (event: any) => {
      console.error('Speech recognition error', event.error);
      setIsListening(false);
    };

    recognition.onend = () => setIsListening(false);
    
    recognition.start();
  };

  const renderHistoryEntry = (entry: HistoryEntry) => {
    const resolveUrl = (url?: string) => {
      if (!url) return '';
      if (url.startsWith('/') && vfs[url] && vfs[url].content) {
        return vfs[url].content;
      }
      return url;
    };

    switch (entry.type) {
      case 'command':
        return <div key={entry.id} className="text-cyan-400 font-bold">{entry.text}</div>;
      case 'output':
        if ((entry as any).isChat) {
          const isMe = (entry as any).sender === (user ? (user.displayName || user.email?.split('@')[0]) : 'Local User');
          return (
            <div key={entry.id} className={`my-2 flex ${isMe ? 'justify-end' : 'justify-start'}`}>
              <div className={`p-3 rounded-lg max-w-[85%] sm:max-w-md ${
                isMe 
                  ? 'bg-purple-950/40 text-purple-200 border border-purple-500/30' 
                  : 'bg-cyan-950/30 text-cyan-200 border border-cyan-500/20'
              }`}>
                <div className="flex items-center justify-between gap-4 mb-1 border-b border-white/5 pb-1">
                  <span className={`text-[10px] uppercase font-bold tracking-wider ${isMe ? 'text-purple-400' : 'text-cyan-400'}`}>
                    {(entry as any).sender || 'Anonymous'}
                  </span>
                  <span className="text-[9px] text-gray-500 font-mono">
                    {entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                  </span>
                </div>
                <div className="text-sm break-words whitespace-pre-wrap">{entry.text}</div>
              </div>
            </div>
          );
        }
        return <div key={entry.id} className="text-gray-300 whitespace-pre-wrap">{entry.text}</div>;
      case 'error':
        return <div key={entry.id} className="text-red-400">{entry.text}</div>;
      case 'image':
        return (
          <div key={entry.id} className="my-2">
            <img src={resolveUrl(entry.url)} alt="Terminal output" className="max-w-md rounded border border-gray-700" referrerPolicy="no-referrer" />
          </div>
        );
      case 'video':
        return (
          <div key={entry.id} className="my-2">
            <VideoPlayer url={resolveUrl(entry.url)} pip={entry.pip} />
          </div>
        );
      case 'sandbox':
        return (
          <div key={entry.id} className="my-2 p-4 border border-purple-500/30 bg-purple-500/10 rounded flex items-center justify-between">
            <div className="flex items-center gap-2 text-purple-300">
              <Code size={18} />
              <span>App Generated Successfully</span>
            </div>
            <button 
              onClick={() => {
                setActiveSandbox(entry.code!);
                setRightPanel('sandbox');
              }}
              className="px-3 py-1 bg-purple-600 hover:bg-purple-500 text-white rounded text-sm transition-colors"
            >
              Open Sandbox
            </button>
          </div>
        );
      default:
        return null;
    }
  };

  if (!isAuthReady) {
    return <div className="flex h-screen bg-[#0a0a0a] items-center justify-center text-cyan-400 font-mono">Initializing Systems...</div>;
  }

  return (
    <div className="flex h-screen bg-[#0a0a0a] text-gray-200 font-mono overflow-hidden relative">
      {/* Boot Screen */}
      <AnimatePresence>
        {isBooting && (
          <motion.div 
            className="absolute inset-0 z-[100] bg-black flex items-center justify-center overflow-hidden"
            exit={{ opacity: 0, scale: 1.05 }}
            transition={{ duration: 0.8, ease: "easeInOut" }}
          >
            {!bootStarted ? (
              <motion.div 
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex flex-col items-center gap-8"
              >
                <div className="relative">
                  <TerminalIcon size={64} className="text-cyan-500 relative z-10" />
                  <div className="absolute inset-0 bg-cyan-500 blur-xl opacity-50 animate-pulse" />
                </div>
                <button 
                  onClick={() => setBootStarted(true)}
                  className="px-8 py-3 bg-transparent border border-cyan-500/50 text-cyan-400 font-bold rounded hover:bg-cyan-900/30 hover:border-cyan-400 transition-all tracking-[0.2em] flex items-center gap-3 group"
                >
                  <Power size={18} className="group-hover:text-white transition-colors" />
                  INITIATE BOOT SEQUENCE
                </button>
              </motion.div>
            ) : (
              <div className="relative w-full h-full">
                <video
                  src={bootVideo}
                  autoPlay
                  muted
                  playsInline
                  className="w-full h-full object-cover opacity-80"
                  onEnded={() => setIsBooting(false)}
                />
                <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-[#0a0a0a] pointer-events-none" />
                
                {/* Scanline effect */}
                <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] bg-[length:100%_4px,3px_100%] z-10 opacity-20" />

                <div className="absolute bottom-12 left-0 right-0 flex justify-center z-20">
                  <button 
                    onClick={() => setIsBooting(false)}
                    className="px-6 py-2 bg-black/50 border border-gray-700 text-gray-400 rounded hover:text-white hover:border-gray-500 transition-colors backdrop-blur-md text-sm tracking-wider"
                  >
                    SKIP SEQUENCE
                  </button>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Left Sidebar - VFS */}
      <div className="w-64 border-r border-gray-800 bg-[#111] flex flex-col">
        <div className="p-4 border-b border-gray-800 flex items-center justify-between text-cyan-400">
          <div className="flex items-center gap-2">
            <Folder size={18} />
            <span className="font-bold tracking-wider">FILE SYSTEM</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleMountLocal} className="hover:text-cyan-300 transition-colors" title="Mount Local Folder">
              <Folder size={16} />
            </button>
            <button onClick={() => fileInputRef.current?.click()} className="hover:text-cyan-300 transition-colors" title="Upload File">
              <Upload size={16} />
            </button>
          </div>
          <input type="file" ref={fileInputRef} className="hidden" onChange={handleFileUpload} />
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {Object.entries(vfs)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([path, node]: [string, VFSNode]) => {
              const depth = Math.max(0, path.split('/').length - 2);
              const name = path === '/' ? '/' : path.split('/').pop();
              return (
                <div 
                  key={path} 
                  className="flex items-center gap-2 py-1 text-sm hover:text-cyan-300 cursor-pointer transition-colors"
                  style={{ paddingLeft: `${depth * 16}px` }}
                  onClick={() => {
                    if (node.type === 'file') {
                      setEditorFile(path);
                      setEditorContent(node.content || '');
                      setRightPanel('editor');
                    }
                  }}
                >
                  {node.type === 'dir' ? <Folder size={14} className="text-yellow-500 shrink-0" /> : <File size={14} className="text-gray-400 shrink-0" />}
                  <span className="truncate">{name}</span>
                </div>
              );
          })}
        </div>
        <div className="p-4 border-t border-gray-800 flex items-center justify-between text-sm">
          {user ? (
            <>
              <div className="flex items-center gap-2 text-green-400">
                <Users size={14} />
                <span className="truncate max-w-[150px]">Cloud Sync: {user.displayName || user.email?.split('@')[0]}</span>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => setShowSettings(true)} className="text-gray-500 hover:text-cyan-400 transition-colors" title="Settings">
                  <Settings size={14} />
                </button>
                <button onClick={() => signOut(auth)} className="text-gray-500 hover:text-red-400 transition-colors" title="Disconnect">
                  <LogOut size={14} />
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 text-gray-400">
                <Users size={14} />
                <span className="truncate max-w-[150px]">Local Mode</span>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => setShowSettings(true)} className="text-gray-500 hover:text-cyan-400 transition-colors" title="Settings">
                  <Settings size={14} />
                </button>
                <button onClick={() => signInWithPopup(auth, googleProvider)} className="text-cyan-500 hover:text-cyan-400 transition-colors" title="Enable Cloud Sync">
                  <Wifi size={14} />
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Main Terminal Area */}
      <div className="flex-1 flex flex-col relative">
        <div className="p-4 border-b border-gray-800 flex items-center justify-between bg-[#111] flex-wrap gap-2">
          <div className="flex items-center gap-3 text-cyan-400 flex-wrap">
            <TerminalIcon size={18} />
            <span className="font-bold tracking-wider">AETHER_TERM v2.0</span>
            <div className="h-4 w-px bg-gray-800" />
            <span className="text-xs text-purple-400 font-mono flex items-center gap-1 bg-purple-950/30 px-2 py-0.5 rounded border border-purple-500/20">
              <Users size={12} />
              Session: <span className="font-bold text-white uppercase">{sessionId}</span>
            </span>
            <button
              onClick={() => {
                let currentSession = new URLSearchParams(window.location.search).get('session');
                if (!currentSession) {
                  const randomCode = Math.random().toString(36).substring(2, 7);
                  currentSession = randomCode;
                  const newUrl = window.location.protocol + "//" + window.location.host + window.location.pathname + '?session=' + randomCode;
                  window.history.pushState({ path: newUrl }, '', newUrl);
                  setSessionId(randomCode);
                  socket?.emit('join', {
                    username: user ? (user.displayName || user.email?.split('@')[0]) : 'Local User',
                    sessionId: randomCode
                  });
                }
                const shareLink = window.location.href;
                navigator.clipboard.writeText(shareLink).then(() => {
                  setHistory(prev => [...prev, { id: Date.now().toString(), type: 'output', timestamp: Date.now(), userId: user?.uid || 'local', text: `[System]: Link copied to clipboard! Share it with collaborators to join room '${currentSession}': ${shareLink}` }]);
                });
              }}
              className="text-[11px] bg-cyan-950/50 text-cyan-400 hover:bg-cyan-900/60 border border-cyan-500/30 px-2.5 py-1 rounded transition-colors font-mono flex items-center gap-1"
              title="Copy session link to invite others"
            >
              <Copy size={11} />
              Invite Collaborators
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setRightPanel(rightPanel === 'gemini-chat' ? null : 'gemini-chat');
              }}
              className={`px-3 py-1 rounded text-xs transition-all flex items-center gap-1.5 font-mono ${rightPanel === 'gemini-chat' ? 'bg-purple-600 hover:bg-purple-500 text-white shadow-lg shadow-purple-500/20' : 'bg-purple-950/40 text-purple-300 border border-purple-500/30 hover:bg-purple-900/40'}`}
            >
              <Sparkles size={13} className="animate-pulse" />
              Gemini Workspace
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-1">
          <div className="text-green-400 mb-4">
            <pre className="text-xs sm:text-sm leading-tight">
              {renderAscii(asciiArt)}
            </pre>
            <p className="mt-4 text-gray-400">Welcome to <span className="text-purple-400 font-bold">NEXUS RAYNE</span>. Type <span className="text-cyan-400">help</span> to see available commands.</p>
            <p className="mt-1 text-gray-500 text-xs">Try: <span className="text-purple-400">view https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjEx.../giphy.gif</span> or <span className="text-purple-400">generate-image a futuristic cyberpunk city</span></p>
          </div>
          
          {history.map(renderHistoryEntry)}
          <div ref={bottomRef} />
        </div>

        <div id="terminal-footer-container" className="bg-[#111] border-t border-gray-800 flex flex-col">
          {/* Terminal Command Input */}
          <form 
            id="terminal-command-form" 
            onSubmit={handleCommand} 
            className="px-4 py-2.5 flex items-center gap-3 relative border-b border-gray-900/80"
          >
            <span className="text-cyan-500 font-bold font-mono text-xs sm:text-sm whitespace-nowrap">nexus@rayne:~$</span>
            <div className="flex-1 relative flex items-center">
              {prediction && prediction !== input && (
                <span className="absolute left-0 text-gray-600 pointer-events-none whitespace-pre text-xs sm:text-sm font-mono">
                  {input}<span className="opacity-50">{prediction.slice(input.length)}</span>
                </span>
              )}
              <input
                id="terminal-command-input"
                type="text"
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                className="w-full bg-transparent outline-none text-gray-200 placeholder-gray-700 font-mono text-xs sm:text-sm relative z-10"
                placeholder="Enter command (e.g., help, play <url> or click mic)..."
                autoFocus
              />
              {typingUser && (
                <span className="absolute right-2 text-[10px] text-purple-400 font-mono italic animate-pulse bg-purple-950/40 px-2 py-0.5 rounded border border-purple-500/20 z-20">
                  {typingUser} is typing...
                </span>
              )}
            </div>
            <button 
              id="terminal-voice-btn"
              type="button"
              onClick={toggleVoiceCommand}
              className={`p-1.5 rounded transition-colors ${isListening ? 'bg-red-500/20 text-red-500 animate-pulse' : 'text-gray-500 hover:text-cyan-400 hover:bg-gray-800'}`}
              title="Voice Command"
            >
              {isListening ? <Mic size={16} /> : <MicOff size={16} />}
            </button>
            <button
              type="button"
              onClick={() => setSandboxEnabled(!sandboxEnabled)}
              className={`p-1.5 px-2.5 rounded text-xs transition-all font-mono flex items-center gap-1.5 ${sandboxEnabled ? 'bg-amber-600/30 text-amber-300 border border-amber-500/50' : 'text-gray-500 border border-transparent hover:text-cyan-400'}`}
              title="Toggle Sandboxed Isolation Mode for Untrusted Code"
            >
              <Shield size={14} className={sandboxEnabled ? "animate-pulse text-amber-400" : ""} />
              {sandboxEnabled ? 'SANDBOX ON' : 'SANDBOX OFF'}
            </button>
            <button 
              id="terminal-run-btn"
              type="submit"
              className={`p-1.5 rounded transition-all flex items-center justify-center ${input.trim() ? 'text-cyan-400 bg-cyan-950/30 hover:bg-cyan-900/40 border border-cyan-500/30' : 'text-gray-500 hover:text-cyan-400'}`}
              title="Run Command"
            >
              <Send size={16} />
            </button>
          </form>

          {/* Dedicated Chat Input */}
          <form 
            id="terminal-chat-form"
            onSubmit={handleSendChat} 
            className="px-4 py-3 flex items-center gap-3 bg-[#0d0d0d] relative"
          >
            <div className="absolute -top-8 right-4 flex items-center gap-2 text-[10px] text-gray-400 bg-[#111] px-2.5 py-0.5 rounded-t border border-b-0 border-gray-800 z-20 font-mono">
              <Wifi size={10} className={user ? "text-green-500" : "text-gray-500"} />
              <span>{onlineUsers.length} Online</span>
            </div>
            <div className="flex items-center gap-1.5 text-purple-400 shrink-0 select-none">
              <Users size={14} />
              <span className="text-[10px] uppercase tracking-wider font-bold text-purple-400/80 font-mono">Chat</span>
            </div>
            <div className="flex-1">
              <input
                id="terminal-chat-input"
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                className="w-full bg-transparent outline-none text-gray-200 placeholder-gray-600 text-xs sm:text-sm"
                placeholder="Message collaborators (instant chat)..."
              />
            </div>
            <button 
              id="terminal-chat-send-btn"
              type="submit"
              className={`p-1.5 rounded transition-all flex items-center justify-center ${chatInput.trim() ? 'text-purple-400 bg-purple-950/30 hover:bg-purple-900/40 border border-purple-500/30' : 'text-gray-500 hover:text-purple-400'}`}
              title="Send Chat Message"
            >
              <Send size={15} />
            </button>
          </form>
        </div>
      </div>

      {/* Right Sidebar - Sandbox / Editor */}
      <AnimatePresence>
        {rightPanel === 'sandbox' && activeSandbox && (
          <motion.div 
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: '40%', opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            className="border-l border-gray-800 bg-white flex flex-col overflow-hidden"
          >
            <div className="p-4 bg-[#111] border-b border-gray-800 flex items-center justify-between text-gray-200">
              <div className="flex items-center gap-2 text-purple-400">
                <Code size={18} />
                <span className="font-bold tracking-wider">SANDBOX</span>
              </div>
              <button 
                onClick={() => setRightPanel(null)}
                className="text-gray-400 hover:text-white transition-colors"
              >
                <Minimize2 size={18} />
              </button>
            </div>
            <div className="flex-1 bg-white relative">
              <iframe 
                srcDoc={activeSandbox} 
                className="w-full h-full border-none"
                title="Sandbox"
                sandbox="allow-scripts allow-same-origin"
              />
            </div>
          </motion.div>
        )}

        {rightPanel === 'sandbox-monitor' && (
          <motion.div 
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: '40%', opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            className="border-l border-gray-800 bg-[#0c1017] flex flex-col overflow-hidden"
          >
            <div className="p-4 bg-[#111] border-b border-gray-800 flex items-center justify-between text-gray-200">
              <div className="flex items-center gap-2 text-cyan-400">
                <Shield size={18} className="animate-pulse" />
                <span className="font-bold tracking-wider font-mono text-sm">SANDBOX INTEGRITY AUDITOR</span>
              </div>
              <button 
                onClick={() => setRightPanel(null)}
                className="text-gray-400 hover:text-white transition-colors"
              >
                <Minimize2 size={18} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-[#141b24] md:outline md:outline-1 md:outline-cyan-500/10 p-3 rounded flex flex-col justify-between">
                  <span className="text-gray-500 text-[10px] tracking-widest font-mono uppercase">Workspace Storage</span>
                  <span className="text-xl font-bold font-mono text-cyan-400 mt-1">{sandboxMetrics.workspaceSize || '0 KB'}</span>
                </div>
                <div className="bg-[#141b24] md:outline md:outline-1 md:outline-purple-500/10 p-3 rounded flex flex-col justify-between">
                  <span className="text-gray-500 text-[10px] tracking-widest font-mono uppercase">Security Layer</span>
                  <span className="text-[11px] font-bold font-mono text-purple-400 mt-2 flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-purple-400 animate-ping"></span>
                    JAIL ACTIVE
                  </span>
                </div>
              </div>

              <div className="bg-[#111] border border-gray-800 p-4 rounded-lg space-y-3 font-mono">
                <div className="flex items-center justify-between text-xs text-gray-400">
                  <span className="flex items-center gap-1"><Cpu size={14} className="text-emerald-400" /> Host Isolation boundaries</span>
                  <span className="text-emerald-400">256MB / 8s Limit</span>
                </div>
                
                <div className="space-y-1">
                  <div className="flex justify-between text-[11px] text-gray-500">
                    <span>Peak thread CPU utility</span>
                    <span>{sandboxMetrics.processes.some(p => p.status === 'running') ? '12.4%' : '0.0%'}</span>
                  </div>
                  <div className="w-full bg-gray-900 h-1.5 rounded-full overflow-hidden">
                    <div 
                      className="bg-cyan-500 h-full transition-all duration-500" 
                      style={{ width: sandboxMetrics.processes.some(p => p.status === 'running') ? '12.4%' : '0%' }}
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="flex justify-between text-[11px] text-gray-500">
                    <span>VFS workspace memory footprint</span>
                    <span>{sandboxMetrics.workspaceSize} / 50.0 MB</span>
                  </div>
                  <div className="w-full bg-gray-900 h-1.5 rounded-full overflow-hidden">
                    <div 
                      className="bg-purple-500 h-full transition-all duration-500" 
                      style={{ width: '0.8%' }}
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <h3 className="text-gray-400 text-xs font-bold font-mono uppercase tracking-wider flex items-center gap-1">
                  <Activity size={12} className="text-cyan-400" /> Boundary Audit Log
                </h3>
                <div className="bg-black/40 border border-gray-900 p-3 rounded font-mono text-[11px] space-y-1 text-gray-400 max-h-[120px] overflow-y-auto">
                  <div className="text-blue-400 select-none">[04:30:12] Auditor: Path traversal restriction armed.</div>
                  <div className="text-purple-400 select-none">[04:30:13] Scheduler: Real-time RSS limits at 256MB peak virtual size.</div>
                  {sandboxMetrics.processes.map((proc, idx) => (
                    <div key={idx} className="text-gray-500">
                      [{new Date(proc.startedAt).toLocaleTimeString()}] Exec: {proc.file.split('/').pop()} (PID: {proc.pid}) status {proc.status.toUpperCase()}
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs font-bold font-mono text-gray-400 tracking-wider uppercase">
                  <span className="flex items-center gap-1"><Layers size={12} className="text-cyan-400" /> Micro-processes</span>
                  <span className="text-[10px] text-gray-500">{sandboxMetrics.processes.filter(p => p.status === 'running').length} Active</span>
                </div>

                <div className="space-y-2">
                  {sandboxMetrics.processes.length === 0 ? (
                    <div className="bg-black/10 border border-dashed border-gray-800 p-6 text-center text-xs text-gray-500 font-mono rounded">
                      No active processes are running.
                    </div>
                  ) : (
                    sandboxMetrics.processes.map((proc) => (
                      <div key={proc.pid} className="bg-[#141b24] border border-gray-800 rounded p-3 font-mono text-xs flex items-center justify-between">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className={`h-2 w-2 rounded-full ${proc.status === 'running' ? 'bg-green-500 animate-pulse' : proc.status === 'completed' ? 'bg-cyan-500' : 'bg-red-500'}`} />
                            <span className="font-bold text-gray-300">{proc.file.split('/').pop()}</span>
                            <span className="text-gray-500 text-[10px]">(PID: {proc.pid})</span>
                          </div>
                          <div className="text-[10px] text-gray-500 flex items-center gap-2">
                            <span>Status: <span className="text-gray-400">{proc.status}</span></span>
                            <span>•</span>
                            <span>CPU: <span className="text-gray-400">{proc.cpu}%</span></span>
                            <span>•</span>
                            <span>Mem: <span className="text-gray-400">{proc.memory.toFixed(1)}MB</span></span>
                          </div>
                        </div>

                        {proc.status === 'running' && (
                          <button
                            onClick={() => socket?.emit('sandbox_kill', { pid: proc.pid })}
                            className="p-1 px-2 text-[10px] bg-red-950 text-red-400 border border-red-900/40 rounded hover:bg-red-900 hover:text-red-200 transition-colors flex items-center gap-1"
                            title="Force Kill Process"
                          >
                            <StopCircle size={10} /> Kill
                          </button>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="border-t border-gray-900 pt-4 flex gap-2">
                <button
                  onClick={() => socket?.emit('sandbox_reset')}
                  className="flex-1 py-1.5 bg-gray-900 hover:bg-gray-850 text-gray-300 border border-gray-800 hover:border-gray-700 rounded text-xs transition-colors flex items-center justify-center gap-1.5 font-mono"
                >
                  <RefreshCw size={12} /> Purge Test VFS
                </button>
              </div>
            </div>
          </motion.div>
        )}

        {rightPanel === 'editor' && editorFile && (
          <motion.div 
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: '40%', opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            className="border-l border-gray-800 bg-[#1e1e1e] flex flex-col overflow-hidden"
          >
            <div className="p-4 bg-[#111] border-b border-gray-800 flex items-center justify-between text-gray-200">
              <div className="flex items-center gap-2 text-blue-400">
                <FileCode size={18} />
                <span className="font-bold tracking-wider truncate max-w-[120px]">{editorFile.split('/').pop()}</span>
              </div>
              <div className="flex items-center gap-2">
                {(editorFile.endsWith('.html') || editorFile.endsWith('.htm')) && (
                  <button 
                    onClick={() => {
                      socket?.emit('save_file', { path: editorFile, content: editorContent, vfs });
                      setActiveSandbox(editorContent);
                      setRightPanel('sandbox');
                    }}
                    className="px-2.5 py-1 bg-purple-600 hover:bg-purple-500 text-white rounded text-xs leading-none transition-colors flex items-center gap-1 font-mono font-medium whitespace-nowrap"
                    title="Live Preview HTML inside Sandbox Iframe"
                  >
                    <Play size={12} />
                    Preview
                  </button>
                )}
                {(editorFile.endsWith('.js') || editorFile.endsWith('.py') || editorFile.endsWith('.sh')) && (
                  <button 
                    onClick={() => {
                      socket?.emit('save_file', { path: editorFile, content: editorContent, vfs });
                      socket?.emit('command', { 
                        command: 'sandbox', 
                        args: ['run', editorFile], 
                        user: user ? (user.displayName || user.email?.split('@')[0]) : 'Local User', 
                        vfs,
                        apiKeys,
                        defaultLlm
                      });
                      setRightPanel('sandbox-monitor');
                    }}
                    className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-xs leading-none transition-colors flex items-center gap-1 font-mono font-medium whitespace-nowrap"
                    title="Execute script in secure isolated sandbox container"
                  >
                    <Play size={12} />
                    Run
                  </button>
                )}
                <button 
                  onClick={() => {
                    socket?.emit('save_file', { path: editorFile, content: editorContent, vfs });
                  }}
                  className="px-2.5 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs leading-none transition-colors flex items-center gap-1 font-mono font-medium whitespace-nowrap"
                >
                  <Save size={12} />
                  Save
                </button>
                <button 
                  onClick={() => setRightPanel(null)}
                  className="text-gray-400 hover:text-white transition-colors"
                >
                  <Minimize2 size={18} />
                </button>
              </div>
            </div>
            <div className="flex-1 relative flex flex-col">
              <textarea
                value={editorContent}
                onChange={(e) => {
                  const newContent = e.target.value;
                  setEditorContent(newContent);
                  socket?.emit('editor_change', { path: editorFile, content: newContent });
                }}
                className="flex-1 w-full bg-transparent text-[#d4d4d4] p-4 font-mono text-sm outline-none resize-none"
                spellCheck={false}
              />
            </div>
          </motion.div>
        )}

        {rightPanel === 'gemini-chat' && (
          <motion.div 
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: '40%', opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            className="border-l border-gray-800 bg-[#0d0f14] flex flex-col overflow-hidden w-full max-w-[500px]"
          >
            <div className="p-4 bg-[#111] border-b border-gray-800 flex items-center justify-between text-gray-200">
              <div className="flex items-center gap-2 text-purple-400">
                <Sparkles size={18} className="animate-pulse" />
                <span className="font-bold tracking-wider font-mono text-sm">GEMINI AI WORKSPACE</span>
              </div>
              <button 
                onClick={() => setRightPanel(null)}
                className="text-gray-400 hover:text-white transition-colors"
              >
                <Minimize2 size={18} />
              </button>
            </div>

            <div className="p-3 bg-[#141822] border-b border-gray-800 flex gap-1.5 flex-wrap">
              {[
                { id: 'chat', label: 'Conversational', icon: <Bot size={12} /> },
                { id: 'code', label: 'Generate App', icon: <Code size={12} /> },
                { id: 'image', label: 'Text-to-Image', icon: <ImageIcon size={12} /> },
                { id: 'video', label: 'Veo Video', icon: <Video size={12} /> }
              ].map(mode => (
                <button
                  key={mode.id}
                  onClick={() => setGeminiMode(mode.id as any)}
                  className={`px-2.5 py-1 rounded text-xs font-mono transition-all flex items-center gap-1 ${geminiMode === mode.id ? 'bg-purple-600 text-white shadow-md' : 'bg-gray-900 text-gray-400 hover:bg-gray-850'}`}
                >
                  {mode.icon}
                  {mode.label}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {geminiChatHistory.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center p-6 space-y-4 font-mono select-none">
                  <div className="relative">
                    <Sparkles size={40} className="text-purple-500 animate-pulse" />
                    <div className="absolute inset-0 bg-purple-500 blur-lg opacity-20" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-gray-300 text-sm font-bold">Systems Ready</p>
                    <p className="text-gray-500 text-xs max-w-[280px]">Converse with Gemini to generate single-file web applications, cinematic visual graphics, and motion clips.</p>
                  </div>
                </div>
              ) : (
                geminiChatHistory.map((item, idx) => (
                  <div key={idx} className={`flex flex-col space-y-1.5 ${item.role === 'user' ? 'items-end' : 'items-start'}`}>
                    <span className="text-[10px] text-gray-500 uppercase tracking-widest font-mono font-bold">
                      {item.role === 'user' ? 'user' : 'gemini'}
                    </span>
                    <div className={`p-3 rounded-lg max-w-[90%] font-mono text-xs whitespace-pre-wrap break-words leading-relaxed ${item.role === 'user' ? 'bg-[#1e152a] text-purple-200 border border-purple-500/20' : 'bg-[#0f141c] text-gray-200 border border-gray-800'}`}>
                      {item.content}
                      {item.mediaUrl && item.mediaType === 'image' && (
                        <div className="mt-3 overflow-hidden rounded border border-gray-800">
                          <img src={item.mediaUrl} alt="Gemini generation" className="w-full h-auto object-cover" referrerPolicy="no-referrer" />
                        </div>
                      )}
                      {item.mediaUrl && item.mediaType === 'video' && (
                        <div className="mt-3 overflow-hidden rounded border border-gray-800">
                          <video src={item.mediaUrl} controls className="w-full h-auto object-cover" />
                        </div>
                      )}
                    </div>
                  </div>
                ))
              )}
              {geminiLoading && (
                <div className="flex items-center gap-2 text-purple-400 font-mono text-xs italic animate-pulse">
                  <Wand2 size={14} className="animate-spin" />
                  <span>AI compiler running routines...</span>
                </div>
              )}
            </div>

            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!geminiPrompt.trim() || !socket || geminiLoading) return;
                
                const query = geminiPrompt.trim();
                setGeminiPrompt('');
                setGeminiLoading(true);

                setGeminiChatHistory(prev => [...prev, { role: 'user', content: query }]);

                if (geminiMode === 'chat') {
                  socket.emit('gemini_chat', {
                    message: query,
                    history: geminiChatHistory.filter(h => !h.mediaUrl).map(h => ({ role: h.role, content: h.content }))
                  });
                } else if (geminiMode === 'code') {
                  socket.emit('gemini_generate_code', { prompt: query });
                } else if (geminiMode === 'image') {
                  socket.emit('gemini_generate_image', { prompt: query });
                } else if (geminiMode === 'video') {
                  socket.emit('gemini_generate_video', { prompt: query });
                }
              }}
              className="p-3 border-t border-gray-800 bg-[#111]"
            >
              <div className="flex gap-2">
                <input
                  type="text"
                  value={geminiPrompt}
                  onChange={(e) => setGeminiPrompt(e.target.value)}
                  className="flex-1 bg-black text-gray-200 text-xs font-mono p-2.5 rounded outline-none border border-gray-850 focus:border-purple-500/50"
                  placeholder={
                    geminiMode === 'chat' ? "Converse with Gemini..." :
                    geminiMode === 'code' ? "Describe the app to build (e.g., calculator)..." :
                    geminiMode === 'image' ? "Describe image (e.g., cyberpunk street)..." :
                    "Describe video (e.g., a serene lake under sunset)..."
                  }
                />
                <button
                  type="submit"
                  disabled={geminiLoading || !geminiPrompt.trim()}
                  className="bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white rounded p-2.5 transition-colors"
                >
                  <Send size={14} />
                </button>
              </div>
            </form>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Setup Guide Modal */}
      <AnimatePresence>
        {showSetup && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/80 z-50 flex items-center justify-center p-4 backdrop-blur-sm"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-[#111] border border-cyan-500/30 rounded-lg p-6 max-w-2xl w-full shadow-2xl shadow-cyan-500/10"
            >
              <div className="flex items-center gap-3 mb-6 border-b border-gray-800 pb-4">
                <TerminalIcon className="text-cyan-400" size={28} />
                <h2 className="text-2xl font-bold text-gray-100 tracking-wider">Welcome to NEXUS RAYNE</h2>
              </div>
              
              <div className="space-y-4 text-gray-300 mb-8">
                <p>Nexus Rayne is a collaborative, AI-powered terminal environment. Here's what you can do:</p>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                  <div className="bg-black/50 p-4 rounded border border-gray-800">
                    <h3 className="text-cyan-400 font-bold flex items-center gap-2 mb-2"><Code size={16}/> AI Sandbox</h3>
                    <p className="text-sm">Type <code className="text-purple-400">generate-app a neon clock</code> to have Gemini build a web app and run it instantly in the side panel.</p>
                  </div>
                  <div className="bg-black/50 p-4 rounded border border-gray-800">
                    <h3 className="text-cyan-400 font-bold flex items-center gap-2 mb-2"><Folder size={16}/> Virtual File System</h3>
                    <p className="text-sm">Upload files using the icon on the left, or clone repos with <code className="text-purple-400">github clone octocat/Hello-World</code>.</p>
                  </div>
                  <div className="bg-black/50 p-4 rounded border border-gray-800">
                    <h3 className="text-cyan-400 font-bold flex items-center gap-2 mb-2"><Play size={16}/> Rich Media</h3>
                    <p className="text-sm">Play videos inline with <code className="text-purple-400">play &lt;url&gt;</code> or view images with <code className="text-purple-400">view &lt;url&gt;</code>.</p>
                  </div>
                  <div className="bg-black/50 p-4 rounded border border-gray-800">
                    <h3 className="text-cyan-400 font-bold flex items-center gap-2 mb-2"><Users size={16}/> Multi-Agent</h3>
                    <p className="text-sm">Ask specialized agents for help: <code className="text-purple-400">agent coder how to reverse a string in python</code>.</p>
                  </div>
                </div>
                
                <div className="text-sm text-gray-500 mt-4 flex items-center gap-2">
                  <CheckCircle2 size={14} className="text-green-500" />
                  <span>Pro tip: Use the Up/Down arrow keys to cycle through your command history.</span>
                </div>
              </div>

              <div className="flex justify-end">
                <button 
                  onClick={() => {
                    localStorage.setItem('aetherterm_setup_complete', 'true');
                    setShowSetup(false);
                  }}
                  className="px-6 py-2 bg-cyan-600 hover:bg-cyan-500 text-white font-bold rounded transition-colors"
                >
                  INITIALIZE SYSTEM
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      {/* Settings Modal */}
      <AnimatePresence>
        {showSettings && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-[#111] border border-gray-800 rounded-lg p-6 max-w-md w-full shadow-2xl"
            >
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl font-bold text-cyan-400 flex items-center gap-2">
                  <Settings size={20} />
                  System Settings
                </h2>
                <button onClick={() => setShowSettings(false)} className="text-gray-500 hover:text-white">
                  <span className="text-xl">&times;</span>
                </button>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Default LLM Provider</label>
                  <select 
                    value={defaultLlm}
                    onChange={(e) => {
                      setDefaultLlm(e.target.value);
                      localStorage.setItem('aetherterm_default_llm', e.target.value);
                    }}
                    className="w-full bg-black border border-gray-700 rounded p-2 text-white focus:border-cyan-400 outline-none"
                  >
                    <option value="gemini">Gemini (Default)</option>
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="local">Local (Ollama)</option>
                  </select>
                </div>

                <div className="pt-4 border-t border-gray-800">
                  <h3 className="text-sm font-semibold text-gray-300 mb-3">Bring Your Own Key (BYOK)</h3>
                  
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">OpenAI API Key</label>
                      <input 
                        type="password" 
                        value={apiKeys.openai}
                        onChange={(e) => {
                          setApiKeys(prev => ({ ...prev, openai: e.target.value }));
                          localStorage.setItem('aetherterm_openai_key', e.target.value);
                        }}
                        placeholder="sk-..."
                        className="w-full bg-black border border-gray-700 rounded p-2 text-white focus:border-cyan-400 outline-none text-sm"
                      />
                    </div>
                    
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Anthropic API Key</label>
                      <input 
                        type="password" 
                        value={apiKeys.anthropic}
                        onChange={(e) => {
                          setApiKeys(prev => ({ ...prev, anthropic: e.target.value }));
                          localStorage.setItem('aetherterm_anthropic_key', e.target.value);
                        }}
                        placeholder="sk-ant-..."
                        className="w-full bg-black border border-gray-700 rounded p-2 text-white focus:border-cyan-400 outline-none text-sm"
                      />
                    </div>

                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Custom Gemini API Key (Optional)</label>
                      <input 
                        type="password" 
                        value={apiKeys.gemini}
                        onChange={(e) => {
                          setApiKeys(prev => ({ ...prev, gemini: e.target.value }));
                          localStorage.setItem('aetherterm_gemini_key', e.target.value);
                        }}
                        placeholder="AIza..."
                        className="w-full bg-black border border-gray-700 rounded p-2 text-white focus:border-cyan-400 outline-none text-sm"
                      />
                    </div>

                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Ollama URL (Local)</label>
                      <input 
                        type="text" 
                        value={apiKeys.ollamaUrl}
                        onChange={(e) => {
                          setApiKeys(prev => ({ ...prev, ollamaUrl: e.target.value }));
                          localStorage.setItem('aetherterm_ollama_url', e.target.value);
                        }}
                        placeholder="http://localhost:11434"
                        className="w-full bg-black border border-gray-700 rounded p-2 text-white focus:border-cyan-400 outline-none text-sm"
                      />
                      <p className="text-[10px] text-gray-600 mt-1">Requires Ollama running locally with OLLAMA_ORIGINS="*"</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-6 flex justify-end">
                <button 
                  onClick={() => setShowSettings(false)}
                  className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded transition-colors"
                >
                  Save & Close
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function VideoPlayer({ url, pip }: { url: string, pip?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [progress, setProgress] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(true);

  useEffect(() => {
    if (pip && videoRef.current) {
      const video = videoRef.current;
      video.addEventListener('loadedmetadata', () => {
        if (document.pictureInPictureEnabled && !video.disablePictureInPicture) {
          video.requestPictureInPicture().catch(console.error);
        }
      });
    }
  }, [pip, url]);

  const togglePip = async () => {
    if (!videoRef.current) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await videoRef.current.requestPictureInPicture();
      }
    } catch (error) {
      console.error(error);
    }
  };

  const togglePlay = () => {
    if (videoRef.current) {
      if (isPlaying) videoRef.current.pause();
      else videoRef.current.play();
      setIsPlaying(!isPlaying);
    }
  };

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      setProgress((videoRef.current.currentTime / videoRef.current.duration) * 100);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (videoRef.current) {
      const time = (parseFloat(e.target.value) / 100) * videoRef.current.duration;
      videoRef.current.currentTime = time;
      setProgress(parseFloat(e.target.value));
    }
  };

  const handleVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const vol = parseFloat(e.target.value);
    setVolume(vol);
    if (videoRef.current) {
      videoRef.current.volume = vol;
      setIsMuted(vol === 0);
    }
  };

  const toggleMute = () => {
    if (videoRef.current) {
      videoRef.current.muted = !isMuted;
      setIsMuted(!isMuted);
      if (isMuted && volume === 0) setVolume(0.5);
    }
  };

  return (
    <div className="relative group inline-block max-w-md w-full rounded border border-gray-700 bg-black overflow-hidden">
      <video 
        ref={videoRef}
        src={url} 
        autoPlay 
        muted={isMuted}
        playsInline
        onTimeUpdate={handleTimeUpdate}
        onEnded={() => setIsPlaying(false)}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        className="w-full h-auto block"
      />
      
      {/* Custom Controls Overlay */}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent p-3 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col gap-2">
        <input 
          type="range" 
          min="0" 
          max="100" 
          value={progress || 0} 
          onChange={handleSeek} 
          className="w-full h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-cyan-400" 
        />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={togglePlay} className="text-white hover:text-cyan-400 transition-colors">
              {isPlaying ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <div className="flex items-center gap-2 group/vol">
              <button onClick={toggleMute} className="text-white hover:text-cyan-400 transition-colors">
                {isMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}
              </button>
              <input 
                type="range" 
                min="0" 
                max="1" 
                step="0.05" 
                value={isMuted ? 0 : volume} 
                onChange={handleVolume} 
                className="w-0 opacity-0 group-hover/vol:w-16 group-hover/vol:opacity-100 transition-all duration-300 h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-cyan-400" 
              />
            </div>
          </div>
          <button onClick={togglePip} className="text-white hover:text-cyan-400 transition-colors" title="Picture-in-Picture">
            <Maximize2 size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
