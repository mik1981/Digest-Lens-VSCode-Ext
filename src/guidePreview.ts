import * as vscode from 'vscode';
import { Uri } from 'vscode';

export interface GuideContent {
  rawMd: string;
  lang: string;
  title: string;
}

const INSPECTOR_MARKDOWN = `# CRC Inspector Avanzato

Usa questo pannello per analizzare internamente il calcolo CRC:
- Step-by-step byte per byte (stato prima/dopo, table index, table value)
- Espansione del polinomio (es: \`0x1021 -> x^16 + x^12 + x^5 + 1\`)
- Tabella pre-generata a 256 entry
- Bit reflection in realtime

<div id="crc-inspector-anchor"></div>
`;

// Tipo per le variabili del template
interface ThemeColors {
  accentColor: string;
  accentHover: string;
  heading2Color: string;
  heading3Color: string;
  bgColor: string;
  textColor: string;
  cardBg: string;
  borderColor: string;
  tocBg: string;
  linkHoverBg: string;
  linkHoverColor: string;
  codeBg: string;
  codeText: string;
}

// Palette predefinita light/dark
const lightTheme: ThemeColors = {
  accentColor: '#3b82f6',
  accentHover: '#2563eb',
  heading2Color: '#1e40af',
  heading3Color: '#1e3a8a',
  bgColor: '#ffffff',
  textColor: '#1f2937',
  cardBg: '#f9fafb',
  borderColor: '#e5e7eb',
  tocBg: '#f3f4f6',
  linkHoverBg: 'rgba(59,130,246,0.1)',
  linkHoverColor: '#3b82f6',
  codeBg: '#f1f5f9',
  codeText: '#1f2937'
};

const darkTheme: ThemeColors = {
  accentColor: '#3b82f6',
  accentHover: '#2563eb',
  heading2Color: '#93c5fd',
  heading3Color: '#60a5fa',
  bgColor: '#1f1f2e',
  textColor: '#d4d4f0',
  cardBg: '#2a2a3c',
  borderColor: '#3f3f55',
  tocBg: '#252536',
  linkHoverBg: 'rgba(59,130,246,0.2)',
  linkHoverColor: '#93c5fd',
  codeBg: '#2d2d3d',
  codeText: '#e0e0f0'
};

export async function getGuideContent(context: vscode.ExtensionContext): Promise<GuideContent> {
  const lang = vscode.env.language.split('-')[0] || 'en';
  const guidePath = `l10n/guide_${lang}.md`;
  
  let guideUri = Uri.joinPath(context.extensionUri, guidePath);
  try {
    await vscode.workspace.fs.stat(guideUri);
  } catch {
    guideUri = Uri.joinPath(context.extensionUri, 'l10n/guide_en.md');
  }
  
  const rawBytes = await vscode.workspace.fs.readFile(guideUri);
  const rawMd = new TextDecoder().decode(rawBytes);
  
  return {
    rawMd,
    lang: lang === 'en' ? 'en' : 'it',
    title: `DigestLens Guide (${lang.toUpperCase()})`
  };
}

export function createGuidePanel(
  context: vscode.ExtensionContext, 
  content: GuideContent, 
  output: vscode.OutputChannel
) 
{
  const panel = vscode.window.createWebviewPanel(
    'digestlens.guidePreview',
    content.title,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        Uri.joinPath(context.extensionUri, 'media'),
        Uri.joinPath(context.extensionUri, 'resources')
      ]
    }
  );

  // Theme sync
  const updateTheme = async (output?: vscode.OutputChannel) => {
    const isDark = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark;
    // panel.webview.html = getWebviewHtml(content.rawMd, isDark, panel.webview.cspSource);
    const html = await getWebviewHtml(context, panel.webview, isDark, output);
    panel.webview.html = html;
    // Re-render MD after theme change
    panel.webview.postMessage({ command: 'render', md: content.rawMd });
    // Send theme change message to webview
    panel.webview.postMessage({ command: 'themeChange', isDark: isDark });
  };
  const updateThemeWrapper = async () => {
    updateTheme();
  }

  // Message handler - send MD to webview
  const messageListener = panel.webview.onDidReceiveMessage(
    (message) => {
      switch (message.command) {
        case 'loadContent':
          panel.webview.postMessage({ command: 'render', md: content.rawMd });
          break;
      }
    },
    undefined,
    context.subscriptions
  );

  updateTheme(output);
  vscode.window.onDidChangeActiveColorTheme(updateThemeWrapper, undefined, context.subscriptions);

  // Handle resize
  panel.onDidChangeViewState(() => {
    panel.webview.postMessage({ command: 'resize' });
  }, undefined, context.subscriptions);

  return panel;

}

export function createInspectorPanel(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
) {
  const panel = vscode.window.createWebviewPanel(
    'digestlens.crcInspector',
    'CRC Inspector',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        Uri.joinPath(context.extensionUri, 'media'),
        Uri.joinPath(context.extensionUri, 'resources')
      ]
    }
  );

  const updateTheme = async () => {
    const isDark = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark;
    const html = await getWebviewHtml(context, panel.webview, isDark, output);
    panel.webview.html = html;
    panel.webview.postMessage({ command: 'render', md: INSPECTOR_MARKDOWN });
    panel.webview.postMessage({ command: 'themeChange', isDark });
  };

  panel.webview.onDidReceiveMessage(
    (message) => {
      if (message.command === 'loadContent') {
        panel.webview.postMessage({ command: 'render', md: INSPECTOR_MARKDOWN });
      }
    },
    undefined,
    context.subscriptions
  );

  updateTheme();
  vscode.window.onDidChangeActiveColorTheme(updateTheme, undefined, context.subscriptions);

  panel.onDidChangeViewState(() => {
    panel.webview.postMessage({ command: 'resize' });
  }, undefined, context.subscriptions);

  return panel;
}

function getNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

export async function getWebviewHtml(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  isDark: boolean,
  output?: vscode.OutputChannel
): Promise<string> {

  const htmlUri = vscode.Uri.joinPath(context.extensionUri, 'media', 'guide.html');
  const htmlBytes = await vscode.workspace.fs.readFile(htmlUri);
  let html = new TextDecoder().decode(htmlBytes);

  const nonce = getNonce();

  // URI conversion (fondamentale!)
  const mainJs = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'media', 'main.js')
  );

  const highlightCss = 'https://cdn.jsdelivr.net/npm/highlight.js@11.10.0/styles/github-dark.min.css';
  const highlightJs = 'https://cdn.jsdelivr.net/npm/highlight.js@11.10.0/lib/highlight.min.js';
  // const highlightJs = webview.asWebviewUri(localr));
  const markedJs = 'https://cdn.jsdelivr.net/npm/marked@14.1.2/marked.min.js';

  // Funzione per sostituire {{...}} nel template HTML
  function applyThemeToHtml(html: string, theme: ThemeColors): string {
    return html.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      return (theme as any)[key] ?? '';
    });
  }

  html = html
    .replace(/{{cspSource}}/g, webview.cspSource)
    .replace(/{{nonce}}/g, nonce)
    .replace(/{{mainJs}}/g, mainJs.toString())
    .replace(/{{highlightCss}}/g, highlightCss)
    .replace(/{{highlightJs}}/g, highlightJs)
    .replace(/{{markedJs}}/g, markedJs);

  // output?.appendLine(`il tema selezionato è scuro: ${isDark}`);
  html = applyThemeToHtml(html, isDark? darkTheme : lightTheme);
  
  // output?.appendLine(`contenuto html:\n${html}`);
  return html;
}

export function registerGuidePreviewCommands(context: vscode.ExtensionContext) {
  // Placeholder for registration (called from extension.ts)
}
