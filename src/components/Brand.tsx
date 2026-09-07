export const APP_NAME = "scholay today";
export const BRAND_WORDMARK = "SCHOLAY";

/** Display branding only; persisted keys and native app identity stay stable. */
export default function Brand({ className = "" }: { className?: string }) {
  return <div className={`app-brand ${className}`} aria-label={APP_NAME}>
    <img className="app-brand-logo" src="/scholay-logo.png" alt="" width={24} height={25}/>
    <span className="app-brand-name">{BRAND_WORDMARK}</span>
  </div>;
}
