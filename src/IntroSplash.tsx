import { useEffect, useState } from 'react';

export default function IntroSplash({ onDone }: { onDone: () => void }) {
  const [showWordmark, setShowWordmark] = useState(false);
  const [fadeOut, setFadeOut] = useState(false);

  useEffect(() => {
    const t1 = setTimeout(() => setShowWordmark(true), 650);
    const t2 = setTimeout(() => setFadeOut(true), 2150);
    const t3 = setTimeout(() => onDone(), 2650);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [onDone]);

  return (
    <div className={`intro-splash${fadeOut ? ' intro-splash-out' : ''}`} aria-hidden="true">
      <div className="intro-glow intro-glow-a" />
      <div className="intro-glow intro-glow-b" />
      <img src="/svg/gordyx-foodfor.svg" alt="" className="intro-foodfor" />
      {showWordmark && <img src="/svg/gordyx-wordmark.svg" alt="Gordyx" className="intro-wordmark" />}
    </div>
  );
}
