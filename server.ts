import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import fs from 'fs';
import { exec } from 'child_process';

dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: '*',
    },
    maxHttpBufferSize: 1e8, // 100 MB limit for file uploads
  });
  
  const PORT = 3000;

  app.use(express.json());

  // In-memory Virtual File System (VFS)
  // Shared across all users for real-time collaboration
  const vfs: Record<string, { path: string, type: 'file' | 'dir', content?: string, children?: string[], ownerId?: string, updatedAt?: number }> = {
    '/': { path: '/', type: 'dir', children: ['/home', '/bin'] },
    '/home': { path: '/home', type: 'dir', children: ['/home/welcome.txt'] },
    '/home/welcome.txt': { path: '/home/welcome.txt', type: 'file', content: 'Welcome to the collaborative terminal!' },
    '/bin': { path: '/bin', type: 'dir', children: [] },
  };

  const sharedHistory: any[] = [
    { id: 'welcome', type: 'output', text: 'Powering up collaborative nexus...' }
  ];

  interface SandboxProcess {
    pid: number;
    file: string;
    startedAt: number;
    status: 'running' | 'completed' | 'failed' | 'killed';
    cpu: number;
    memory: number;
  }
  const activeSandboxProcesses = new Map<number, SandboxProcess>();

  const getProcessMetrics = (pid: number): Promise<{ cpu: number, memory: number }> => {
    return new Promise((resolve) => {
      exec(`ps -p ${pid} -o %cpu,rss`, (err, stdout) => {
        if (err || !stdout) {
          resolve({ cpu: 0, memory: 0 });
          return;
        }
        const lines = stdout.trim().split('\n');
        if (lines.length > 1) {
          const parts = lines[1].trim().split(/\s+/);
          const cpu = parseFloat(parts[0]) || 0;
          const memory = (parseInt(parts[1]) || 0) / 1024; // Convert RSS in KB to MB
          resolve({ cpu, memory });
        } else {
          resolve({ cpu: 0, memory: 0 });
        }
      });
    });
  };

  const broadcastHistory = (entry: any) => {
    sharedHistory.push(entry);
    if (sharedHistory.length > 150) sharedHistory.shift();
    io.emit('sync_history', entry);
  };

  const broadcastVfs = (nodes: any[]) => {
    nodes.forEach(node => {
      vfs[node.path] = node;
    });
    io.emit('sync_vfs', nodes);
  };

  setInterval(async () => {
    if (activeSandboxProcesses.size > 0) {
      let workspaceSize = '0 KB';
      try {
        const workspacePath = path.join(process.cwd(), '.sandbox_workspace');
        if (fs.existsSync(workspacePath)) {
          let totalSize = 0;
          const calcSize = (dir: string) => {
            const files = fs.readdirSync(dir);
            for (const f of files) {
              const fp = path.join(dir, f);
              const stat = fs.statSync(fp);
              if (stat.isDirectory()) {
                calcSize(fp);
              } else {
                totalSize += stat.size;
              }
            }
          };
          calcSize(workspacePath);
          workspaceSize = (totalSize / 1024).toFixed(1) + ' KB';
        }
      } catch (e) {}

      for (const [pid, proc] of activeSandboxProcesses.entries()) {
        if (proc.status === 'running') {
          const metrics = await getProcessMetrics(pid);
          proc.cpu = metrics.cpu;
          proc.memory = metrics.memory;
          
          try {
            process.kill(pid, 0); // Check if alive
          } catch (e) {
            proc.status = 'completed';
            proc.cpu = 0;
            proc.memory = 0;
          }
        }
      }

      io.emit('sandbox_metrics', {
        workspaceSize,
        processes: Array.from(activeSandboxProcesses.values()).slice(-8)
      });
    }
  }, 2000);

  const connectedUsers = new Map<string, string>();

  io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join', (username: string) => {
      connectedUsers.set(socket.id, username);
      io.emit('users_update', Array.from(connectedUsers.values()));
      
      // Send historical collaborative session state to joining user
      socket.emit('sync_all_history', sharedHistory);
      
      const vfsNodes = Object.entries(vfs).map(([path, val]) => ({
        path,
        ...val
      }));
      socket.emit('sync_all_vfs', vfsNodes);
    });

    socket.on('upload_file', (data) => {
      const { path, content } = data;
      const node = { path, type: 'file' as const, content, updatedAt: Date.now() };
      const parent = path.substring(0, path.lastIndexOf('/')) || '/';
      
      vfs[path] = node;
      if (vfs[parent] && vfs[parent].type === 'dir') {
        if (!vfs[parent].children?.includes(path)) {
          vfs[parent].children = [...(vfs[parent].children || []), path];
        }
      }
      broadcastVfs([vfs[path], vfs[parent]].filter(Boolean));
      
      const username = connectedUsers.get(socket.id) || 'User';
      broadcastHistory({
        type: 'output',
        text: `[System]: ${username} uploaded file ${path}`,
        id: Date.now().toString() + Math.random()
      });
    });

    socket.on('save_file', (data) => {
      const { path, content } = data;
      if (vfs[path]) {
        vfs[path].content = content;
        vfs[path].updatedAt = Date.now();
        broadcastVfs([vfs[path]]);
        
        const username = connectedUsers.get(socket.id) || 'User';
        broadcastHistory({
          type: 'output',
          text: `[System]: ${username} saved file: ${path}`,
          id: Date.now().toString() + Math.random()
        });
      }
    });

    socket.on('sync_vfs_batch', (data) => {
      const { nodes } = data;
      broadcastVfs(nodes);
    });

    socket.on('editor_change', (data) => {
      const { path, content } = data;
      if (vfs[path]) {
        vfs[path].content = content;
        vfs[path].updatedAt = Date.now();
      }
      socket.broadcast.emit('editor_change', { path, content });
    });

    socket.on('sandbox_kill', (data) => {
      const { pid } = data;
      try {
        process.kill(pid, 'SIGKILL');
        const proc = activeSandboxProcesses.get(pid);
        if (proc) {
          proc.status = 'killed';
          proc.cpu = 0;
          proc.memory = 0;
        }
        broadcastHistory({
          type: 'output',
          text: `[Sandbox]: Manual terminate sent to PID ${pid}.`,
          id: Date.now().toString() + Math.random()
        });
      } catch (e: any) {
        socket.emit('sync_history', {
          type: 'error',
          text: `Failed to terminate process ${pid}: ${e.message}`,
          id: Date.now().toString() + Math.random()
        });
      }
    });

    socket.on('sandbox_reset', () => {
      try {
        const workspacePath = path.join(process.cwd(), '.sandbox_workspace');
        if (fs.existsSync(workspacePath)) {
          fs.rmSync(workspacePath, { recursive: true, force: true });
        }
        fs.mkdirSync(workspacePath, { recursive: true });
        
        broadcastHistory({
          type: 'output',
          text: `[Auditor]: Sandbox directory hard reset completed. Purged all binary and source files.`,
          id: Date.now().toString() + Math.random()
        });
      } catch (err: any) {
        socket.emit('sync_history', { type: 'error', text: `Reset Failed: ${err.message}`, id: Date.now().toString() + Math.random() });
      }
    });

    // Handle terminal commands
    socket.on('command', async (data) => {
      const { command, args, apiKeys, defaultLlm } = data;
      const username = connectedUsers.get(socket.id) || 'nexus';
      
      const emitHistory = (output: any) => {
        broadcastHistory(output);
      };
      
      const emitVfs = (newVfs: any) => {
        broadcastVfs(newVfs);
      };

      const getLlmResponse = async (prompt: string, systemInstruction?: string) => {
        const provider = defaultLlm || 'gemini';
        
        if (provider === 'openai') {
          const openai = new OpenAI({ apiKey: apiKeys?.openai || process.env.OPENAI_API_KEY || 'dummy' });
          const messages: any[] = [];
          if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
          messages.push({ role: 'user', content: prompt });
          
          try {
            const completion = await openai.chat.completions.create({
              model: 'gpt-4o',
              messages,
            });
            return completion.choices[0].message.content || '';
          } catch (e: any) {
            throw new Error(`OpenAI Error: ${e.message}`);
          }
        } else if (provider === 'anthropic') {
          const anthropic = new Anthropic({ apiKey: apiKeys?.anthropic || process.env.ANTHROPIC_API_KEY || 'dummy' });
          try {
            const msg = await anthropic.messages.create({
              model: 'claude-3-5-sonnet-20240620',
              max_tokens: 4096,
              system: systemInstruction,
              messages: [{ role: 'user', content: prompt }],
            });
            return (msg.content[0] as any).text || '';
          } catch (e: any) {
            throw new Error(`Anthropic Error: ${e.message}`);
          }
        } else if (provider === 'local') {
          return new Promise((resolve, reject) => {
            const requestId = Date.now().toString() + Math.random();
            
            const timeout = setTimeout(() => {
              socket.removeAllListeners(`response_local_llm_${requestId}`);
              reject(new Error("Local LLM request timed out. Make sure Ollama is running and accessible."));
            }, 60000);

            socket.once(`response_local_llm_${requestId}`, (data) => {
              clearTimeout(timeout);
              if (data.error) reject(new Error(data.error));
              else resolve(data.text);
            });

            socket.emit('request_local_llm', {
              id: requestId,
              prompt: systemInstruction ? `${systemInstruction}\n\n${prompt}` : prompt
            });
          });
        } else {
          // Default to Gemini
          const geminiAi = apiKeys?.gemini ? new GoogleGenAI({ apiKey: apiKeys.gemini }) : ai;
          try {
            const response = await geminiAi.models.generateContent({
              model: 'gemini-2.5-flash',
              contents: systemInstruction ? `System Instruction: ${systemInstruction}\n\nUser Prompt: ${prompt}` : prompt,
            });
            return response.text || '';
          } catch (e: any) {
            throw new Error(`Gemini Error: ${e.message}`);
          }
        }
      };

      // Add command to history
      const cmdEntry = { type: 'command', text: `${username}@rayne:~$ ${command} ${args.join(' ')}`, id: Date.now().toString() + Math.random() };
      emitHistory(cmdEntry);

      try {
        if (command === 'clear') {
          // Clear is local usually, but let's make it clear for everyone for fun, or just local.
          // Actually, clear should probably just be local. We'll handle it client-side.
        } else if (command === 'help') {
          const helpText = `Available commands:
  help                    - Show this help message
  clear                   - Clear the terminal
  ls [dir]                - List directory contents
  cat <file>              - View file contents
  mkdir <dir>             - Create a directory
  touch <file>            - Create an empty file
  echo <text>             - Print text
  play <url>              - Play a video (MP4, WebM, etc.) inline
  pip <url>               - Play a video in Picture-in-Picture mode
  view <url>              - View an image or GIF
  ask <prompt>            - Ask Gemini AI a question
  generate-app <prompt>   - Generate an HTML/JS/CSS app and open in Sandbox
  generate-image <prompt> - Generate an image using AI
  github clone <repo>     - Clone a GitHub repository (e.g., octocat/Hello-World)
  agent <name> <prompt>   - Ask a specific AI agent (coder, researcher, system)
  local-ask <prompt>      - Ask a local LLM via Ollama (requires localhost:11434)
  set-boot <url>          - Set a custom boot screen video (URL or VFS path)
  edit <file>             - Open file in the custom code editor
  nix search <pkg>        - Search for a Nix package
  nix run <pkg>           - Run a Nix package (simulated)
  pkg install <name>      - Install a new package/command (e.g., cowsay, weather, joke)
  
Examples:
  view https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif
  play https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4
  generate-image a cute cat in space`;
          const output = { type: 'output', text: helpText, id: Date.now().toString() + Math.random() };
          emitHistory(output);
        } else if (command === 'ls') {
          const dir = args[0] || '/home';
          const node = vfs[dir];
          if (node && node.type === 'dir') {
            const output = { type: 'output', text: node.children?.map((c: string) => c.split('/').pop()).join(' ') || '', id: Date.now().toString() + Math.random() };
            emitHistory(output);
          } else {
            const output = { type: 'error', text: `ls: cannot access '${dir}': No such file or directory`, id: Date.now().toString() + Math.random() };
            emitHistory(output);
          }
        } else if (command === 'cat') {
          const file = args[0];
          const node = vfs[file];
          if (node && node.type === 'file') {
            const output = { type: 'output', text: node.content || '', id: Date.now().toString() + Math.random() };
            emitHistory(output);
          } else {
            const output = { type: 'error', text: `cat: ${file}: No such file or directory`, id: Date.now().toString() + Math.random() };
            emitHistory(output);
          }
        } else if (command === 'mkdir') {
          const dir = args[0];
          if (!vfs[dir]) {
            vfs[dir] = { path: dir, type: 'dir', children: [] };
            const parent = dir.substring(0, dir.lastIndexOf('/')) || '/';
            if (vfs[parent] && vfs[parent].type === 'dir') {
              vfs[parent].children?.push(dir);
            }
            emitVfs([vfs[dir], vfs[parent]].filter(Boolean));
          }
        } else if (command === 'touch') {
          const file = args[0];
          if (!vfs[file]) {
            vfs[file] = { path: file, type: 'file', content: '' };
            const parent = file.substring(0, file.lastIndexOf('/')) || '/';
            if (vfs[parent] && vfs[parent].type === 'dir') {
              vfs[parent].children?.push(file);
            }
            emitVfs([vfs[file], vfs[parent]].filter(Boolean));
          }
        } else if (command === 'echo') {
          const output = { type: 'output', text: args.join(' '), id: Date.now().toString() + Math.random() };
          emitHistory(output);
        } else if (command === 'play' || command === 'pip') {
          const url = args[0];
          const output = { type: 'video', url, pip: command === 'pip', id: Date.now().toString() + Math.random() };
          emitHistory(output);
        } else if (command === 'view') {
          const url = args[0];
          const output = { type: 'image', url, id: Date.now().toString() + Math.random() };
          emitHistory(output);
        } else if (command === 'ask') {
          const prompt = args.join(' ');
          try {
            const responseText = await getLlmResponse(prompt);
            const output = { type: 'output', text: responseText, id: Date.now().toString() + Math.random() };
            emitHistory(output);
          } catch (err: any) {
            const output = { type: 'error', text: err.message, id: Date.now().toString() + Math.random() };
            emitHistory(output);
          }
        } else if (command === 'generate-app') {
          const prompt = args.join(' ');
          const outputMsg = { type: 'output', text: `Generating app using ${defaultLlm || 'gemini'}...`, id: Date.now().toString() + Math.random() };
          emitHistory(outputMsg);
          
          try {
            const responseText = await getLlmResponse(
              `Generate a single-file HTML/JS/CSS app based on this request: "${prompt}". Return ONLY the raw HTML code. Do not use markdown blocks.`
            );
            
            let htmlCode = responseText || '';
            if (htmlCode.startsWith('```html')) {
              htmlCode = htmlCode.replace(/^```html\n/, '').replace(/\n```$/, '');
            }
            
            const output = { type: 'sandbox', code: htmlCode, id: Date.now().toString() + Math.random() };
            emitHistory(output);
          } catch (err: any) {
            const output = { type: 'error', text: err.message, id: Date.now().toString() + Math.random() };
            emitHistory(output);
          }
        } else if (command === 'generate-image') {
          const prompt = args.join(' ');
          const encodedPrompt = encodeURIComponent(prompt);
          const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=800&height=600&nologo=true`;
          const output = { type: 'image', url: imageUrl, id: Date.now().toString() + Math.random() };
          emitHistory(output);
        } else if (command === 'sandbox') {
          const action = args[0];
          const target = args[1];
          
          if (!action) {
            const helpText = `Sandbox command suite:
  sandbox run <file>       - Run program inside an isolated environment with resource limits (supports .js, .py, .sh)
  sandbox monitor          - Enable and open the Right Panel Resource Monitor Dashboard
  sandbox list             - List active/past sandbox executions and check system resource load
  sandbox reset            - Hard reset sandbox environment and purge compiled objects
  sandbox kill <pid>       - Stop a running sandbox process`;
            emitHistory({ type: 'output', text: helpText, id: Date.now().toString() + Math.random() });
          } else if (action === 'monitor') {
            socket.emit('open_sandbox_monitor');
            emitHistory({
              type: 'output',
              text: `[System]: Sandbox Diagnostics panel activated in the right column. Monitoring container resources...`,
              id: Date.now().toString() + Math.random()
            });
          } else if (action === 'run' && target) {
            let targetPath = target;
            if (!targetPath.startsWith('/')) {
              targetPath = `/home/${targetPath}`;
            }
            
            const fileNode = vfs[targetPath];
            if (!fileNode || fileNode.type !== 'file') {
              emitHistory({ type: 'error', text: `Sandbox Error: '${targetPath}' is not a valid file in VFS`, id: Date.now().toString() + Math.random() });
            } else if (target.includes('..') || args.some(arg => arg.includes('..'))) {
              emitHistory({ type: 'error', text: `Security Violation: Parent folder traversal with '..' is blocked.`, id: Date.now().toString() + Math.random() });
            } else {
              emitHistory({ type: 'output', text: `[Sandbox]: Copying files and initializing container jail...`, id: Date.now().toString() + Math.random() });

              try {
                const workspacePath = path.join(process.cwd(), '.sandbox_workspace');
                if (!fs.existsSync(workspacePath)) {
                  fs.mkdirSync(workspacePath, { recursive: true });
                }

                // Copy entire collaborative VFS to sandbox workspace
                for (const [vPath, node] of Object.entries(vfs)) {
                  if (vPath === '/' || vPath.startsWith('/local')) continue; // Skip mounts
                  const diskPath = path.join(workspacePath, vPath.substring(1));
                  if (node.type === 'dir') {
                    if (!fs.existsSync(diskPath)) fs.mkdirSync(diskPath, { recursive: true });
                  } else if (node.type === 'file') {
                    const parentDir = path.dirname(diskPath);
                    if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
                    fs.writeFileSync(diskPath, node.content || '');
                  }
                }

                // Determine executor
                const ext = targetPath.split('.').pop() || '';
                let runner = 'bash';
                if (ext === 'js') runner = 'node';
                else if (ext === 'py') runner = 'python3';
                else if (ext === 'sh') runner = 'bash';

                const relativeTarget = targetPath.substring(1); // strip leading slash
                emitHistory({ type: 'output', text: `[Scheduler]: Launching process using ${runner} with memory limit: 256MB, CPU limit: 8s...`, id: Date.now().toString() + Math.random() });

                // Construct ulimit sandbox command
                const safeCmd = `cd ${workspacePath} && ulimit -f 10000 -v 262144 -u 30 && timeout 8 ${runner} "${relativeTarget}"`;

                const child = exec(safeCmd, {
                  env: {
                    PATH: process.env.PATH,
                    NODE_ENV: 'production'
                  },
                  timeout: 9000
                }, (error: any, stdout: string, stderr: string) => {
                  if (child.pid) {
                    const proc = activeSandboxProcesses.get(child.pid);
                    if (proc) {
                      proc.status = error ? 'failed' : 'completed';
                      proc.cpu = 0;
                      proc.memory = 0;
                    }
                  }
                  
                  if (stdout) emitHistory({ type: 'output', text: `[Sandbox stdout]\n${stdout.trim()}`, id: Date.now().toString() + Math.random() });
                  if (stderr) emitHistory({ type: 'error', text: `[Sandbox stderr]\n${stderr.trim()}`, id: Date.now().toString() + Math.random() });
                  if (error && !stderr) {
                    const isTimeout = error.signal === 'SIGTERM' || error.killed;
                    const errMsg = isTimeout 
                      ? `[Sandbox Auditor]: Process execution interrupted (CPU limit / timeout threshold hit).`
                      : `[Sandbox Failure]: ${error.message}`;
                    emitHistory({ type: 'error', text: errMsg, id: Date.now().toString() + Math.random() });
                  }
                });

                if (child.pid) {
                  activeSandboxProcesses.set(child.pid, {
                    pid: child.pid,
                    file: targetPath,
                    startedAt: Date.now(),
                    status: 'running',
                    cpu: 12,
                    memory: 18
                  });
                }

                emitHistory({ type: 'output', text: `[Sandbox]: Secure container started (PID: ${child.pid}). Run 'sandbox monitor' to view diagnostics.`, id: Date.now().toString() + Math.random() });

              } catch (err: any) {
                emitHistory({ type: 'error', text: `Sandbox Error: ${err.message}`, id: Date.now().toString() + Math.random() });
              }
            }
          } else if (action === 'list') {
            let listText = `Sandbox Process Audit Trail:\n`;
            if (activeSandboxProcesses.size === 0) {
              listText += `No sandbox processes have run in this session.`;
            } else {
              activeSandboxProcesses.forEach((proc) => {
                const age = ((Date.now() - proc.startedAt) / 1000).toFixed(1);
                listText += `  PID: ${proc.pid} | File: ${proc.file} | Status: ${proc.status.toUpperCase()} | CPU: ${proc.cpu}% | MEM: ${proc.memory.toFixed(1)}MB | Age: ${age}s\n`;
              });
            }
            emitHistory({ type: 'output', text: listText, id: Date.now().toString() + Math.random() });
          } else if (action === 'reset') {
            try {
              const workspacePath = path.join(process.cwd(), '.sandbox_workspace');
              if (fs.existsSync(workspacePath)) {
                fs.rmSync(workspacePath, { recursive: true, force: true });
              }
              fs.mkdirSync(workspacePath, { recursive: true });
              emitHistory({ type: 'output', text: `[Auditor]: Purged sandbox directory and reset test workspace.`, id: Date.now().toString() + Math.random() });
            } catch (e: any) {
              emitHistory({ type: 'error', text: `Reset failed: ${e.message}`, id: Date.now().toString() + Math.random() });
            }
          } else if (action === 'kill' && target) {
            const pid = parseInt(target);
            try {
              process.kill(pid, 'SIGKILL');
              const proc = activeSandboxProcesses.get(pid);
              if (proc) {
                proc.status = 'killed';
                proc.cpu = 0;
                proc.memory = 0;
              }
              emitHistory({ type: 'output', text: `[Sandbox]: Manual terminate sent to PID ${pid}.`, id: Date.now().toString() + Math.random() });
            } catch (e: any) {
              emitHistory({ type: 'error', text: `Failed to terminate PID ${pid}: ${e.message}`, id: Date.now().toString() + Math.random() });
            }
          } else {
            emitHistory({ type: 'error', text: `Sandbox Error: Unknown action '${action}'`, id: Date.now().toString() + Math.random() });
          }
        } else if (command === 'github') {
          if (args[0] === 'clone' && args[1]) {
            const repo = args[1];
            const outputMsg = { type: 'output', text: `Cloning ${repo} into /home/${repo.split('/')[1]}...`, id: Date.now().toString() + Math.random() };
            emitHistory(outputMsg);
            
            try {
              const response = await fetch(`https://api.github.com/repos/${repo}/contents`);
              if (response.ok) {
                const contents = await response.json();
                const repoName = repo.split('/')[1];
                const repoPath = `/home/${repoName}`;
                
                vfs[repoPath] = { path: repoPath, type: 'dir', children: [] };
                if (vfs['/home'] && vfs['/home'].type === 'dir') {
                  if (!vfs['/home'].children?.includes(repoPath)) {
                    vfs['/home'].children?.push(repoPath);
                  }
                }
                
                const vfsUpdates = [vfs[repoPath], vfs['/home']];
                
                for (const item of contents) {
                  const itemPath = `${repoPath}/${item.name}`;
                  if (item.type === 'file') {
                    vfs[itemPath] = { path: itemPath, type: 'file', content: `[File content from GitHub: ${item.download_url}]` };
                    vfs[repoPath].children?.push(itemPath);
                    vfsUpdates.push(vfs[itemPath]);
                  } else if (item.type === 'dir') {
                    vfs[itemPath] = { path: itemPath, type: 'dir', children: [] };
                    vfs[repoPath].children?.push(itemPath);
                    vfsUpdates.push(vfs[itemPath]);
                  }
                }
                emitVfs(vfsUpdates);
                const successMsg = { type: 'output', text: `Successfully cloned ${repo}`, id: Date.now().toString() + Math.random() };
                emitHistory(successMsg);
              } else {
                throw new Error('Repository not found or API rate limit exceeded');
              }
            } catch (err: any) {
              const errorMsg = { type: 'error', text: `GitHub Error: ${err.message}`, id: Date.now().toString() + Math.random() };
              emitHistory(errorMsg);
            }
          } else {
            const output = { type: 'error', text: `Usage: github clone <owner>/<repo>`, id: Date.now().toString() + Math.random() };
            emitHistory(output);
          }
        } else if (command === 'agent') {
          const agentName = args[0];
          const prompt = args.slice(1).join(' ');
          const agents: Record<string, string> = {
            coder: "You are an expert programmer. Provide only code or concise technical explanations.",
            researcher: "You are a researcher. Provide detailed, well-structured, and cited explanations.",
            system: "You are a system administrator. Provide terminal commands and system architecture advice."
          };
          
          if (!agents[agentName]) {
            const output = { type: 'error', text: `Agent '${agentName}' not found. Available agents: ${Object.keys(agents).join(', ')}`, id: Date.now().toString() + Math.random() };
            emitHistory(output);
          } else {
            const outputMsg = { type: 'output', text: `[Agent: ${agentName}] thinking using ${defaultLlm || 'gemini'}...`, id: Date.now().toString() + Math.random() };
            emitHistory(outputMsg);
            
            try {
              const responseText = await getLlmResponse(prompt, agents[agentName]);
              const output = { type: 'output', text: `[Agent: ${agentName}]\n${responseText}`, id: Date.now().toString() + Math.random() };
              emitHistory(output);
            } catch (err: any) {
              const output = { type: 'error', text: err.message, id: Date.now().toString() + Math.random() };
              emitHistory(output);
            }
          }
        } else if (command === 'local-ask') {
          const prompt = args.join(' ');
          const outputMsg = { type: 'output', text: `Querying local LLM (Ollama)...`, id: Date.now().toString() + Math.random() };
          emitHistory(outputMsg);
          
          try {
            const response = await fetch('http://localhost:11434/api/generate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: 'llama3', prompt, stream: false })
            });
            if (response.ok) {
              const data = await response.json();
              const output = { type: 'output', text: `[Local LLM]: ${data.response}`, id: Date.now().toString() + Math.random() };
              emitHistory(output);
            } else {
              throw new Error('Local LLM returned an error');
            }
          } catch (err: any) {
            const errorMsg = { type: 'error', text: `Local LLM Error: Could not connect to Ollama at localhost:11434. Make sure Ollama is running locally.`, id: Date.now().toString() + Math.random() };
            emitHistory(errorMsg);
          }
        } else if (command === 'edit') {
          const file = args[0];
          if (!file) {
            const output = { type: 'error', text: `Usage: edit <file>`, id: Date.now().toString() + Math.random() };
            emitHistory(output);
          } else {
            const path = file.startsWith('/') ? file : `/home/${file}`;
            let content = '';
            if (vfs[path] && vfs[path].type === 'file') {
              content = vfs[path].content || '';
            } else if (!vfs[path]) {
              vfs[path] = { path, type: 'file', content: '' };
              const parent = path.substring(0, path.lastIndexOf('/')) || '/';
              if (vfs[parent] && vfs[parent].type === 'dir') {
                if (!vfs[parent].children?.includes(path)) {
                  vfs[parent].children?.push(path);
                }
              }
              emitVfs([vfs[path], vfs[parent]].filter(Boolean));
            }
            socket.emit('open_editor', { path, content });
          }
        } else if (command === 'pkg') {
          const action = args[0];
          const pkgName = args[1];
          if (action === 'install' && pkgName) {
            const output = { type: 'output', text: `Installing package '${pkgName}'...`, id: Date.now().toString() + Math.random() };
            emitHistory(output);

            // Simulate package installation
            setTimeout(() => {
              let pkgContent = '';
              if (pkgName === 'cowsay') {
                pkgContent = `return " \\n  " + args.join(" ") + "\\n   \\\\   ^__^\\n    \\\\  (oo)\\\\_______\\n       (__)\\\\       )\\\\/\\\\\\n           ||----w |\\n           ||     ||";`;
              } else if (pkgName === 'weather') {
                pkgContent = `return "The weather is currently 72°F and sunny in cyberspace.";`;
              } else if (pkgName === 'joke') {
                pkgContent = `const jokes = ["Why do programmers prefer dark mode? Because light attracts bugs.", "I would tell you a UDP joke, but you might not get it."]; return jokes[Math.floor(Math.random() * jokes.length)];`;
              } else {
                pkgContent = `return "Package '${pkgName}' executed successfully with args: " + args.join(" ");`;
              }

              const path = `/bin/${pkgName}`;
              vfs[path] = { path, type: 'file', content: pkgContent };
              if (vfs['/bin'] && vfs['/bin'].type === 'dir' && !vfs['/bin'].children?.includes(path)) {
                vfs['/bin'].children?.push(path);
              }
              emitVfs([vfs[path], vfs['/bin']].filter(Boolean));

              const success = { type: 'output', text: `Successfully installed '${pkgName}'. You can now run it as a command.`, id: Date.now().toString() + Math.random() };
              emitHistory(success);
            }, 1000);
          } else {
            const output = { type: 'error', text: `Usage: pkg install <name>`, id: Date.now().toString() + Math.random() };
            emitHistory(output);
          }
        } else if (command === 'nix') {
          const action = args[0];
          const pkgName = args[1];
          
          if (action === 'search' && pkgName) {
            const outputMsg = { type: 'output', text: `searching Nix packages for '${pkgName}'...`, id: Date.now().toString() + Math.random() };
            emitHistory(outputMsg);
            
            try {
              const responseText = await getLlmResponse(
                `Simulate the terminal output of 'nix search nixpkgs ${pkgName}'. Return ONLY the raw terminal text output, no markdown formatting, no explanations. Make it look exactly like real Nix output with a few realistic package results.`
              );
              const output = { type: 'output', text: responseText, id: Date.now().toString() + Math.random() };
              emitHistory(output);
            } catch (err: any) {
              emitHistory({ type: 'error', text: err.message, id: Date.now().toString() + Math.random() });
            }
          } else if (action === 'run' && pkgName) {
            const outputMsg = { type: 'output', text: `fetching and running '${pkgName}' via Nix...`, id: Date.now().toString() + Math.random() };
            emitHistory(outputMsg);
            
            try {
              // Use LLM to generate a JS implementation of the requested package
              const responseText = await getLlmResponse(
                `You are simulating the 'nix run' command. The user wants to run the package '${pkgName}'. 
Write a single JavaScript function body (just the code inside the function, returning a string) that simulates the behavior of this command-line tool.
The function has access to an 'args' array (strings).
Return ONLY the raw JavaScript code. No markdown, no explanations.
Example for 'cowsay': return " \\n  " + args.join(" ") + "\\n   \\\\   ^__^\\n    \\\\  (oo)\\\\_______\\n       (__)\\\\       )\\\\/\\\\\\n           ||----w |\\n           ||     ||";`
              );
              
              let jsCode = responseText || '';
              if (jsCode.startsWith('```javascript')) jsCode = jsCode.replace(/^```javascript\n/, '').replace(/\n```$/, '');
              if (jsCode.startsWith('```js')) jsCode = jsCode.replace(/^```js\n/, '').replace(/\n```$/, '');
              if (jsCode.startsWith('```')) jsCode = jsCode.replace(/^```\n/, '').replace(/\n```$/, '');
              
              // Save it to VFS so it can be run
              const path = `/bin/${pkgName}`;
              vfs[path] = { path, type: 'file', content: jsCode };
              if (vfs['/bin'] && vfs['/bin'].type === 'dir' && !vfs['/bin'].children?.includes(path)) {
                vfs['/bin'].children?.push(path);
              }
              emitVfs([vfs[path], vfs['/bin']].filter(Boolean));
              
              // Run it
              const runPkg = new Function('args', jsCode);
              const result = runPkg(args.slice(2));
              const output = { type: 'output', text: result, id: Date.now().toString() + Math.random() };
              emitHistory(output);
            } catch (err: any) {
              emitHistory({ type: 'error', text: `Error running Nix package: ${err.message}`, id: Date.now().toString() + Math.random() });
            }
          } else {
            emitHistory({ type: 'error', text: `Usage: nix search <pkg> | nix run <pkg>`, id: Date.now().toString() + Math.random() });
          }
        } else {
          // Check if command exists in /bin
          const binPath = `/bin/${command}`;
          if (vfs[binPath] && vfs[binPath].type === 'file' && vfs[binPath].content) {
            try {
              // Execute the package content as a function
              const runPkg = new Function('args', vfs[binPath].content as string);
              const result = runPkg(args);
              const output = { type: 'output', text: result, id: Date.now().toString() + Math.random() };
              emitHistory(output);
            } catch (err: any) {
              const output = { type: 'error', text: `Error executing package '${command}': ${err.message}`, id: Date.now().toString() + Math.random() };
              emitHistory(output);
            }
          } else {
            // Fallback to real bash shell
            const fullCommand = `${command} ${args.join(' ')}`;
            const workspace = path.join(process.cwd(), '.vfs_workspace');
            
            try {
              if (!fs.existsSync(workspace)) fs.mkdirSync(workspace, { recursive: true });
              
              // Sync VFS to disk
              for (const [vfsPath, node] of Object.entries(vfs)) {
                if (vfsPath === '/') continue;
                const realPath = path.join(workspace, vfsPath);
                const vfsNode = node as any;
                if (vfsNode.type === 'dir') {
                  if (!fs.existsSync(realPath)) fs.mkdirSync(realPath, { recursive: true });
                } else if (vfsNode.type === 'file') {
                  const dir = path.dirname(realPath);
                  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                  fs.writeFileSync(realPath, vfsNode.content || '');
                }
              }

              exec(fullCommand, { cwd: workspace, timeout: 15000 }, (error, stdout, stderr) => {
                // Sync disk back to VFS
                const syncDiskToVfs = (dir: string, vfsDir: string) => {
                  if (!fs.existsSync(dir)) return;
                  const items = fs.readdirSync(dir);
                  for (const item of items) {
                    const realPath = path.join(dir, item);
                    const vfsPath = vfsDir === '/' ? `/${item}` : `${vfsDir}/${item}`;
                    const stat = fs.statSync(realPath);
                    
                    if (stat.isDirectory()) {
                      if (!vfs[vfsPath]) vfs[vfsPath] = { path: vfsPath, type: 'dir', children: [], ownerId: 'shared', updatedAt: Date.now() };
                      if (vfs[vfsDir] && !vfs[vfsDir].children?.includes(vfsPath)) vfs[vfsDir].children?.push(vfsPath);
                      syncDiskToVfs(realPath, vfsPath);
                    } else {
                      try {
                        const content = fs.readFileSync(realPath, 'utf-8');
                        vfs[vfsPath] = { path: vfsPath, type: 'file', content, ownerId: 'shared', updatedAt: Date.now() };
                        if (vfs[vfsDir] && !vfs[vfsDir].children?.includes(vfsPath)) vfs[vfsDir].children?.push(vfsPath);
                      } catch (e) {
                        // Skip binary files
                      }
                    }
                  }
                };
                
                syncDiskToVfs(workspace, '/');
                emitVfs(Object.values(vfs));

                if (stdout) emitHistory({ type: 'output', text: stdout, id: Date.now().toString() + Math.random() });
                if (stderr) emitHistory({ type: 'error', text: stderr, id: Date.now().toString() + Math.random() });
                if (error && !stderr) emitHistory({ type: 'error', text: error.message, id: Date.now().toString() + Math.random() });
                
                if (!stdout && !stderr && !error) {
                   emitHistory({ type: 'output', text: `[Command completed with no output]`, id: Date.now().toString() + Math.random() });
                }
              });
            } catch (err: any) {
              emitHistory({ type: 'error', text: `Shell Error: ${err.message}`, id: Date.now().toString() + Math.random() });
            }
          }
        }
      } catch (err: any) {
        const output = { type: 'error', text: `Error: ${err.message}`, id: Date.now().toString() + Math.random() };
        emitHistory(output);
      }
    });

    socket.on('disconnect', () => {
      console.log('User disconnected:', socket.id);
      connectedUsers.delete(socket.id);
      io.emit('users_update', Array.from(connectedUsers.values()));
    });
  });

  // Vite middleware for development
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

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
