export const APP_NAME = "scholay tody";

/** Display branding only; persisted keys and native app identity stay stable. */
export default function Brand({ className = "" }: { className?: string }) {
  return <div className={`app-brand ${className}`}>
    <img className="app-brand-logo" src="/scholay-logo.png" alt="" width={24} height={25}/>
    <span className="app-brand-name">{APP_NAME}</span>
  </div>;
}
