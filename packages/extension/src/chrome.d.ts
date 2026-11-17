/** Declarações mínimas da API `chrome.*` usada pela extensão (sem depender de @types/chrome). */
/* eslint-disable @typescript-eslint/no-explicit-any -- mensagens vêm sem tipo da API e são conferidas no uso */
declare namespace chrome {
  namespace runtime {
    interface MessageSender {
      tab?: { id?: number; windowId: number };
    }
    const onMessage: {
      addListener(
        cb: (
          message: any,
          sender: MessageSender,
          sendResponse: (response?: any) => void,
        ) => boolean | void,
      ): void;
    };
    function sendMessage(message: unknown): Promise<any>;
  }
  namespace tabs {
    function query(info: { active?: boolean; currentWindow?: boolean }): Promise<{ id?: number }[]>;
    function sendMessage(tabId: number, message: unknown): Promise<any>;
    function captureVisibleTab(windowId: number, options: { format: 'png' }): Promise<string>;
  }
  namespace scripting {
    function executeScript(injection: {
      target: { tabId: number };
      files: string[];
    }): Promise<unknown[]>;
  }
}
