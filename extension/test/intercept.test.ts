import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __test__ } from '../entrypoints/background';

vi.mock('wxt/utils/define-background', () => ({
  defineBackground: (callback: () => void) => callback,
}));

describe('download interception naming', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    __test__.resetState();

    // Mock browser APIs
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn().mockImplementation((key: string) => {
            if (key === 'intercept') return Promise.resolve({ intercept: true });
            if (key === 'serverUrl') return Promise.resolve({ serverUrl: 'http://127.0.0.1:1700' });
            if (key === 'minFileSize') return Promise.resolve({ minFileSize: 10 });
            return Promise.resolve({});
          }),
          set: vi.fn(),
        },
      },
      downloads: {
        cancel: vi.fn().mockResolvedValue(undefined),
        erase: vi.fn().mockResolvedValue(undefined),
        download: vi.fn().mockResolvedValue(9001),
      },
      action: {
        openPopup: vi.fn().mockResolvedValue(undefined),
        setBadgeText: vi.fn(),
        setBadgeBackgroundColor: vi.fn(),
      },
      runtime: {
        id: 'surge-extension-id',
        getURL: vi.fn().mockReturnValue('chrome-extension://id/'),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      },
      notifications: {
        create: vi.fn(),
      },
    });

    // Pre-hydrate state so we don't wait for discovery
    return __test__.ensurePersistedStateLoaded();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([undefined, ''])('sends an empty hint when the browser filename is %s', async (filename) => {
    // 1. Mock health check and download response
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/health')) return { ok: true };
      if (url.includes('/list')) return { ok: true, json: async () => [] };
      if (url.endsWith('/download')) return {
        ok: true,
        json: async () => ({ status: 'queued', id: '123', filename: 'resolved-by-backend.zip' })
      };
      return { ok: false };
    });

    const downloadItem = {
      id: 123,
      filename,
      url: 'https://example.com/original.zip',
      startTime: new Date().toISOString(),
    };

    await __test__.handleDownloadCreated(downloadItem);

    // 2. Verify sendToSurge was called with EMPTY filename
    const downloadCall = mockFetch.mock.calls.find(call => call[0].endsWith('/download'));
    expect(downloadCall).toBeDefined();

    const body = JSON.parse(downloadCall?.[1].body);
    expect(body.filename).toBe('');
    expect(body.url).toBe(downloadItem.url);

    // 3. Verify notification uses RESTRICTED resolved filename from backend response
    expect(browser.notifications.create).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Download started: resolved-by-backend.zip'
    }));
  });

  it.each([
    ['C:\\Users\\me\\chosen name.zip', 'chosen name.zip', 'C:/Users/me'],
    ['/home/me/選択.zip', '選択.zip', '/home/me'],
    ['chosen.zip', 'chosen.zip', undefined],
  ])('preserves the browser filename from %s', async (filename, basename, directory) => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/health')) return { ok: true };
      if (url.includes('/list')) return { ok: true, json: async () => [] };
      if (url.endsWith('/download')) return {
        ok: true,
        json: async () => ({ status: 'queued', id: '456', filename: 'authoritative.zip' })
      };
      return { ok: false };
    });

    const downloadItem = {
      id: 456,
      url: 'https://example.com/file',
      filename,
      startTime: new Date().toISOString(),
    };

    await __test__.handleDownloadCreated(downloadItem);

    const downloadCall = mockFetch.mock.calls.find(call => call[0].endsWith('/download'));
    const body = JSON.parse(downloadCall?.[1].body);
    expect(body.filename).toBe(basename);
    expect(body.filename).not.toMatch(/[\\/]/);
    expect(body.path).toBe(directory);
    expect(mockFetch.mock.calls.filter(call => call[0].endsWith('/download'))).toHaveLength(1);
  });

  it.each([
    ['/downloads/chosen.zip', 'chosen.zip', false],
    ['', '', false],
    ['', '', true],
  ])('preserves duplicate hints after rehydration (filename: %s, hint: %s, legacy: %s)', async (filename, filenameHint, legacy) => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/download/duplicate')) {
        return { ok: true, json: async () => ({ exists: true }) };
      }
      if (url.endsWith('/download')) {
        return { ok: true, json: async () => ({ filename: 'file.zip' }) };
      }
      return { ok: true };
    });

    const url = 'https://example.com/finished.zip';
    await __test__.handleDownloadCreated({ id: 457, url, filename, startTime: new Date().toISOString() });

    const check = mockFetch.mock.calls.find(call => call[0].endsWith('/download/duplicate'));
    expect(JSON.parse(check?.[1].body)).toEqual({ url });
    expect(mockFetch.mock.calls.some(call => call[0].endsWith('/download'))).toBe(false);
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'promptDuplicate', id: 'dup_1', filename: filenameHint || 'finished.zip',
    });

    const stored = (browser.storage.local.set as import('vitest').Mock).mock.calls
      .find(call => call[0].pendingDuplicates)?.[0];
    const persisted = JSON.parse(JSON.stringify(stored));
    expect(persisted.pendingDuplicates[0][1].filenameHint).toBe(filenameHint);
    if (legacy) delete persisted.pendingDuplicates[0][1].filenameHint;
    __test__.resetState();
    (browser.storage.local.get as import('vitest').Mock).mockImplementation((key: string) => {
      if (key === 'pendingDuplicates') return Promise.resolve(persisted);
      if (key === 'serverUrl') return Promise.resolve({ serverUrl: 'http://127.0.0.1:1700' });
      return Promise.resolve({});
    });
    await __test__.rehydratePendingDuplicates();
    expect(await __test__.handleMessage({ type: 'confirmDuplicate', id: 'dup_1' }))
      .toEqual({ success: true });
    const downloads = mockFetch.mock.calls.filter(call => call[0].endsWith('/download'));
    expect(downloads).toHaveLength(1);
    const body = JSON.parse(downloads[0][1].body);
    expect(body.filename).toBe(filenameHint);
    expect(body.path).toBe(filename ? '/downloads' : undefined);
  });

  it('sends the narrow duplicate override without a popup when the warning is disabled', async () => {
    (browser.storage.local.get as import('vitest').Mock).mockImplementation((key: string) => {
      if (key === 'serverUrl') return Promise.resolve({ serverUrl: 'http://127.0.0.1:1700' });
      if (key === 'warnOnDuplicate') return Promise.resolve({ warnOnDuplicate: false });
      return Promise.resolve({});
    });
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/download')) {
        return { ok: true, json: async () => ({ filename: 'file.zip' }) };
      }
      return { ok: true };
    });

    await __test__.handleDownloadCreated({
      id: 458, url: 'https://example.com/finished.zip', startTime: new Date().toISOString(),
    });

    expect(mockFetch.mock.calls.some(call => call[0].endsWith('/download/duplicate'))).toBe(false);
    const download = mockFetch.mock.calls.find(call => call[0].endsWith('/download'));
    expect(JSON.parse(download?.[1].body)).toMatchObject({ skip_duplicate_warning: true });
    expect(browser.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'promptDuplicate' }));
  });

  it('does not cancel the browser download when Surge is offline', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/health')) return { ok: false };
      return { ok: false };
    });

    const downloadItem = {
      id: 789,
      url: 'https://example.com/offline-fallback.zip',
      startTime: new Date().toISOString(),
    };

    await __test__.handleDownloadCreated(downloadItem);

    expect(browser.downloads.cancel).not.toHaveBeenCalled();
    expect(browser.downloads.erase).not.toHaveBeenCalled();

    const downloadCall = mockFetch.mock.calls.find(call => call[0].endsWith('/download'));
    expect(downloadCall).toBeUndefined();
  });

  it('does not hand off a download that the browser could not cancel', async () => {
    (browser.downloads.cancel as import('vitest').Mock).mockRejectedValue(new Error('Already complete'));
    mockFetch.mockResolvedValue({ ok: true });

    await __test__.handleDownloadCreated({
      id: 790,
      url: 'https://example.com/already-complete.zip',
      startTime: new Date().toISOString(),
    });

    expect(browser.downloads.download).not.toHaveBeenCalled();
    expect(mockFetch.mock.calls.some(call => call[0].endsWith('/download'))).toBe(false);
  });

  it('coalesces concurrent interception attempts for the same URL', async () => {
    let releaseCancel: () => void = () => {};
    (browser.downloads.cancel as import('vitest').Mock)
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        releaseCancel = resolve;
      }))
      .mockResolvedValue(undefined);
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/health')) return Promise.resolve({ ok: true });
      if (url.includes('/list')) return Promise.resolve({ ok: true, json: async () => [] });
      if (url.endsWith('/download')) return Promise.resolve({ ok: true, json: async () => ({ filename: 'once.zip' }) });
      return Promise.resolve({ ok: false });
    });

    const first = __test__.handleDownloadCreated({
      id: 791,
      url: 'https://example.com/once.zip',
      startTime: new Date().toISOString(),
    });
    await vi.waitFor(() => expect(browser.downloads.cancel).toHaveBeenCalledOnce());
    const second = __test__.handleDownloadCreated({
      id: 792,
      url: 'https://example.com/once.zip',
      startTime: new Date().toISOString(),
    });

    await second;
    releaseCancel();
    await first;

    expect(browser.downloads.cancel).toHaveBeenCalledTimes(2);
    expect(browser.downloads.cancel).toHaveBeenCalledWith(792);
    expect(mockFetch.mock.calls.filter(call => call[0].endsWith('/download'))).toHaveLength(1);
  });

  describe('browser fallback', () => {
    const failedItem = {
      id: 8001,
      url: 'https://example.com/fallback.zip',
      filename: '/downloads/fallback.zip',
      startTime: new Date().toISOString(),
    };

    beforeEach(() => {
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes('/health')) return { ok: true };
        if (url.includes('/list')) return { ok: true, json: async () => [] };
        if (url.endsWith('/download')) return {
          ok: false,
          status: 503,
          text: async () => 'Surge unavailable',
        };
        return { ok: false };
      });
    });

    it('starts one browser download when the Surge handoff fails by default', async () => {
      await __test__.handleDownloadCreated(failedItem);

      expect(browser.downloads.download).toHaveBeenCalledOnce();
      expect(browser.downloads.download).toHaveBeenCalledWith({ url: failedItem.url });
      expect(browser.notifications.create).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Surge handoff failed; browser retry started: fallback.zip',
      }));
    });

    it('forwards allowed captured headers while excluding rejected headers from the browser retry', async () => {
      __test__.captureHeaders({
        url: failedItem.url,
        requestHeaders: [
          { name: 'X-Download-Token', value: 'token-123' },
          { name: 'Cookie', value: 'session=secret' },
          { name: 'User-Agent', value: 'Surge test agent' },
          { name: 'X-HTTP-Method-Override', value: 'PATCH, TRACE' },
        ],
      });

      await __test__.handleDownloadCreated(failedItem);

      expect(browser.downloads.download).toHaveBeenCalledWith({
        url: failedItem.url,
        headers: [{ name: 'X-Download-Token', value: 'token-123' }],
      });
    });

    it('preserves the Surge failure without retrying when fallback is disabled', async () => {
      (browser.storage.local.get as import('vitest').Mock).mockImplementation((key: string) => {
        if (key === 'interceptEnabled') return Promise.resolve({ interceptEnabled: true });
        if (key === 'serverUrl') return Promise.resolve({ serverUrl: 'http://127.0.0.1:1700' });
        if (key === 'minFileSize') return Promise.resolve({ minFileSize: 10 });
        if (key === 'fallbackToBrowser') return Promise.resolve({ fallbackToBrowser: false });
        return Promise.resolve({});
      });

      await __test__.handleDownloadCreated(failedItem);

      expect(browser.downloads.download).not.toHaveBeenCalled();
      expect(browser.notifications.create).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Failed to start download: Surge unavailable',
      }));
    });

    it('ignores downloads created by this extension so fallback cannot loop', async () => {
      await __test__.handleDownloadCreated({
        ...failedItem,
        id: 8002,
        byExtensionId: 'surge-extension-id',
      });

      expect(browser.downloads.cancel).not.toHaveBeenCalled();
      expect(browser.downloads.download).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('reports both failures when the browser retry is rejected', async () => {
      (browser.downloads.download as import('vitest').Mock).mockRejectedValue(new Error('Download blocked'));

      await __test__.handleDownloadCreated(failedItem);

      expect(browser.notifications.create).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Surge and browser handling failed: Surge unavailable; browser fallback failed: Download blocked',
      }));
    });

    it('does not start a browser retry after a successful Surge handoff', async () => {
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes('/health')) return { ok: true };
        if (url.includes('/list')) return { ok: true, json: async () => [] };
        if (url.endsWith('/download')) return {
          ok: true,
          json: async () => ({ filename: 'fallback.zip' }),
        };
        return { ok: false };
      });

      await __test__.handleDownloadCreated(failedItem);

      expect(browser.downloads.download).not.toHaveBeenCalled();
    });
  });

  describe('minimum file size guard', () => {
    beforeEach(() => {
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes('/health')) return { ok: true };
        if (url.includes('/list')) return { ok: true, json: async () => [] };
        if (url.endsWith('/download')) return {
          ok: true,
          json: async () => ({ status: 'queued', id: '101', filename: 'test.zip' })
        };
        return { ok: false };
      });
    });

    it('does not intercept when totalBytes is smaller than minFileSize threshold', async () => {
      const downloadItem = {
        id: 1001,
        url: 'https://example.com/small.txt',
        startTime: new Date().toISOString(),
        totalBytes: 5 * 1024 * 1024, // 5MB (smaller than default 10MB)
      };

      await __test__.handleDownloadCreated(downloadItem);

      expect(browser.downloads.cancel).not.toHaveBeenCalled();
      const downloadCall = mockFetch.mock.calls.find(call => call[0].endsWith('/download'));
      expect(downloadCall).toBeUndefined();
    });

    it('intercepts when totalBytes is larger than minFileSize threshold', async () => {
      const downloadItem = {
        id: 1002,
        url: 'https://example.com/large.iso',
        startTime: new Date().toISOString(),
        totalBytes: 15 * 1024 * 1024, // 15MB (larger than default 10MB)
      };

      await __test__.handleDownloadCreated(downloadItem);

      expect(browser.downloads.cancel).toHaveBeenCalledWith(1002);
      const downloadCall = mockFetch.mock.calls.find(call => call[0].endsWith('/download'));
      expect(downloadCall).toBeDefined();
    });

    it('intercepts when totalBytes is unknown', async () => {
      const downloadItem = {
        id: 1003,
        url: 'https://example.com/stream.bin',
        startTime: new Date().toISOString(),
        totalBytes: -1, // Unknown size
      };

      await __test__.handleDownloadCreated(downloadItem);

      expect(browser.downloads.cancel).toHaveBeenCalledWith(1003);
      const downloadCall = mockFetch.mock.calls.find(call => call[0].endsWith('/download'));
      expect(downloadCall).toBeDefined();
    });

    it('intercepts when totalBytes is undefined', async () => {
      const downloadItem = {
        id: 1005,
        url: 'https://example.com/stream2.bin',
        startTime: new Date().toISOString(),
      };

      await __test__.handleDownloadCreated(downloadItem);

      expect(browser.downloads.cancel).toHaveBeenCalledWith(1005);
      const downloadCall = mockFetch.mock.calls.find(call => call[0].endsWith('/download'));
      expect(downloadCall).toBeDefined();
    });

    it('intercepts when totalBytes is 0 (zero byte file)', async () => {
      const downloadItem = {
        id: 1006,
        url: 'https://example.com/empty.txt',
        startTime: new Date().toISOString(),
        totalBytes: 0,
      };

      await __test__.handleDownloadCreated(downloadItem);

      expect(browser.downloads.cancel).toHaveBeenCalledWith(1006);
      const downloadCall = mockFetch.mock.calls.find(call => call[0].endsWith('/download'));
      expect(downloadCall).toBeDefined();
    });

    it('intercepts when totalBytes is exactly at the minFileSize threshold', async () => {
      const downloadItem = {
        id: 1007,
        url: 'https://example.com/exact.bin',
        startTime: new Date().toISOString(),
        totalBytes: 10 * 1024 * 1024, // Exactly 10MB default threshold
      };

      await __test__.handleDownloadCreated(downloadItem);

      expect(browser.downloads.cancel).toHaveBeenCalledWith(1007);
      const downloadCall = mockFetch.mock.calls.find(call => call[0].endsWith('/download'));
      expect(downloadCall).toBeDefined();
    });

    it('intercepts everything when minFileSize is 0', async () => {
      (browser.storage.local.get as import('vitest').Mock).mockImplementation((key: string) => {
        if (key === 'intercept') return Promise.resolve({ intercept: true });
        if (key === 'serverUrl') return Promise.resolve({ serverUrl: 'http://127.0.0.1:1700' });
        if (key === 'minFileSize') return Promise.resolve({ minFileSize: 0 });
        return Promise.resolve({});
      });

      const downloadItem = {
        id: 1004,
        url: 'https://example.com/tiny.txt',
        startTime: new Date().toISOString(),
        totalBytes: 1024, // 1KB
      };

      await __test__.handleDownloadCreated(downloadItem);

      expect(browser.downloads.cancel).toHaveBeenCalledWith(1004);
      const downloadCall = mockFetch.mock.calls.find(call => call[0].endsWith('/download'));
      expect(downloadCall).toBeDefined();
    });
  });
});
