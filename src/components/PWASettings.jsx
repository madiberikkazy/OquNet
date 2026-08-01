import { useState, useEffect } from 'react';
import {
  getPWAInfo,
  clearAllCache,
  formatBytes,
  promptInstall,
  requestPersistentStorage,
} from '../utils/pwaUtils.js';

export default function PWASettings() {
  const [pwaInfo, setPwaInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [cacheSize, setCacheSize] = useState('0 Bytes');
  const [persistentStorage, setPersistentStorage] = useState(false);
  const [storageEstimate, setStorageEstimate] = useState(null);

  useEffect(() => {
    async function loadPWAInfo() {
      try {
        const info = await getPWAInfo();
        setPwaInfo(info);
        setCacheSize(info.cacheSize);
        setPersistentStorage(info.persistentStorageAvailable);
        setStorageEstimate(info.storageEstimate);
      } catch (err) {
        console.error('Failed to load PWA info:', err);
      } finally {
        setLoading(false);
      }
    }

    loadPWAInfo();
  }, []);

  async function handleClearCache() {
    setClearing(true);
    try {
      const success = await clearAllCache();
      if (success) {
        setCacheSize('0 Bytes');
        alert('Cache cleared successfully');
      } else {
        alert('Failed to clear cache');
      }
    } catch (err) {
      console.error('Error clearing cache:', err);
      alert('Error clearing cache');
    } finally {
      setClearing(false);
    }
  }

  async function handleRequestPersistentStorage() {
    try {
      const success = await requestPersistentStorage();
      if (success) {
        setPersistentStorage(true);
        alert('Persistent storage requested');
      } else {
        alert('Persistent storage request denied');
      }
    } catch (err) {
      console.error('Error requesting persistent storage:', err);
    }
  }

  async function handleInstallApp() {
    try {
      const installed = await promptInstall();
      if (installed) {
        alert('App installed successfully');
      }
    } catch (err) {
      console.error('Error installing app:', err);
    }
  }

  if (loading) {
    return <div className="px-4 py-8 text-center text-ink-500">Загрузка...</div>;
  }

  if (!pwaInfo) {
    return <div className="px-4 py-8 text-center text-ink-500">Ошибка загрузки</div>;
  }

  return (
    <div className="space-y-6 pb-32">
      {/* Installation Section */}
      {pwaInfo.isInstallPromptAvailable && !pwaInfo.isInstalled && (
        <section>
          <h3 className="text-[17px] font-bold mb-4">Установка</h3>
          <button
            onClick={handleInstallApp}
            className="w-full btn-primary text-center py-3 rounded-lg font-medium"
          >
            Установить приложение
          </button>
          <p className="text-[12px] text-ink-500 mt-2">
            Установите OquNet на главный экран для удобного доступа
          </p>
        </section>
      )}

      {/* Storage Section */}
      <section>
        <h3 className="text-[17px] font-bold mb-4">Хранилище</h3>

        <div className="space-y-3">
          {/* Cache Size */}
          <div className="flex items-center justify-between p-3 rounded-lg bg-ink-50">
            <div>
              <span className="text-[14px] text-ink-700 block">Кеш приложения</span>
              <span className="text-[12px] text-ink-500">{cacheSize}</span>
            </div>
            <button
              onClick={handleClearCache}
              disabled={clearing}
              className="px-3 py-1.5 text-[12px] rounded-lg bg-red-500 text-white hover:bg-red-600 disabled:opacity-60"
            >
              {clearing ? 'Очистка...' : 'Очистить'}
            </button>
          </div>

          {/* Storage Estimate */}
          {storageEstimate && (
            <div className="p-3 rounded-lg bg-ink-50">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[14px] text-ink-700">Использование хранилища</span>
                <span className="text-[12px] text-ink-500">
                  {formatBytes(storageEstimate.usage)} / {formatBytes(storageEstimate.quota)}
                </span>
              </div>
              <div className="w-full h-2 bg-ink-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-brand-500 transition-all"
                  style={{
                    width: `${(storageEstimate.usage / storageEstimate.quota) * 100}%`,
                  }}
                />
              </div>
              <span className="text-[11px] text-ink-500 block mt-1">
                {Math.round((storageEstimate.usage / storageEstimate.quota) * 100)}% использовано
              </span>
            </div>
          )}

          {/* Persistent Storage */}
          <div className="flex items-center justify-between p-3 rounded-lg bg-ink-50">
            <div>
              <span className="text-[14px] text-ink-700 block">Постоянное хранилище</span>
              <span className="text-[12px] text-ink-500">
                {persistentStorage ? 'Разрешено' : 'Не разрешено'}
              </span>
            </div>
            {!persistentStorage && (
              <button
                onClick={handleRequestPersistentStorage}
                className="px-3 py-1.5 text-[12px] rounded-lg bg-brand-500 text-white hover:bg-brand-600"
              >
                Запросить
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Info Section */}
      <section className="p-3 rounded-lg bg-brand-500/10 border border-brand-500/20">
        <p className="text-[13px] text-ink-700">
          <strong>Совет:</strong> Установите приложение для лучшего опыта. Вы сможете получать уведомления и использовать приложение в режиме без интернета.
        </p>
      </section>
    </div>
  );
}
