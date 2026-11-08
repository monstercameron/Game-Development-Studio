import { ExternalLink } from 'lucide-react';

export const FAB_SELLER_PAGE = 'https://www.fab.com/sellers/Quixel%20Megascans';
export const FAB_EULA_URL = 'https://www.fab.com/eula';
export const FAB_TERMS_URL = 'https://www.fab.com/terms-of-service';
export const EPIC_AUP_URL = 'https://dev.epicgames.com/en-US/services/terms/aup';

/** An external link that opens in a new tab and says so, visibly and to screen readers. */
export function ExternalAnchor({ href, children, className }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children} <ExternalLink size={12} aria-hidden="true" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/**
 * The documents that govern Fab content. With a listing, its own licence and its Fab page come
 * first. The licence link is the listing's own (the Standard License is the Fab EULA).
 */
export function LicencesAndTerms({ listing = null, headingId = 'megascans-legal-title' }) {
  return (
    <section className="megascans-legal" aria-labelledby={headingId}>
      <h3 id={headingId} className="megascans-subheading">
        Licences and terms
      </h3>
      <ul>
        {listing && (
          <li>
            <ExternalAnchor href={listing.licenseUrl || FAB_EULA_URL}>
              This listing&apos;s licence: {listing.license}
            </ExternalAnchor>
          </li>
        )}
        {listing && (
          <li>
            <ExternalAnchor href={listing.url}>This listing on Fab</ExternalAnchor>
          </li>
        )}
        <li>
          <ExternalAnchor href={FAB_EULA_URL}>Fab End User License Agreement</ExternalAnchor>
        </li>
        <li>
          <ExternalAnchor href={FAB_TERMS_URL}>Fab Terms of Service</ExternalAnchor>
        </li>
        <li>
          <ExternalAnchor href={EPIC_AUP_URL}>Epic&apos;s Acceptable Use Policy</ExternalAnchor>
        </li>
        <li>
          <ExternalAnchor href={FAB_SELLER_PAGE}>Quixel Megascans on Fab</ExternalAnchor>
        </li>
      </ul>
    </section>
  );
}
