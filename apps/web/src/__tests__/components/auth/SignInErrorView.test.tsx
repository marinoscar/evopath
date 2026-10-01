import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { APP_NAME } from '@app/shared';
import { render } from '../../utils/test-utils';
import { SignInErrorView } from '../../../components/auth/SignInErrorView';
import { AUTH_TAGLINE } from '../../../components/auth/AuthBrandLayout';
import {
  SIGN_IN_ERROR_CODES,
  SIGN_IN_ERROR_CONTENT,
} from '../../../components/auth/signInErrorContent';
import LoginPage from '../../../pages/LoginPage';

function renderView(code: (typeof SIGN_IN_ERROR_CODES)[number] = 'not_allowlisted') {
  const onSignInWithDifferentAccount = vi.fn();
  const onTryAgain = vi.fn();
  const utils = render(
    <SignInErrorView
      code={code}
      onSignInWithDifferentAccount={onSignInWithDifferentAccount}
      onTryAgain={onTryAgain}
    />,
    { wrapperOptions: { authenticated: false } },
  );
  return { ...utils, onSignInWithDifferentAccount, onTryAgain };
}

describe('SignInErrorView', () => {
  describe('brand identity', () => {
    // jsdom does not evaluate media queries, so the md+ brand panel and the
    // compact header are both in the document; `getAllBy` and `hidden: true`
    // are used where the CSS-hidden copy matters.
    it('renders the brand panel: product name and tagline', () => {
      renderView();

      expect(screen.getAllByText(APP_NAME, { exact: true }).length).toBeGreaterThan(0);
      expect(screen.getByText(AUTH_TAGLINE, { ignore: '' })).toBeInTheDocument();
    });

    it('renders only decorative brand marks', () => {
      const { container } = renderView();

      const marks = Array.from(container.querySelectorAll('svg')).filter((svg) =>
        svg.querySelector('circle'),
      );
      expect(marks.length).toBeGreaterThan(0);
      for (const mark of marks) {
        expect(mark).toHaveAttribute('aria-hidden', 'true');
      }
      expect(screen.queryByRole('img', { hidden: true })).toBeNull();
    });

    it('has exactly one h1, the outcome; the brand name is not a heading', () => {
      renderView('not_allowlisted');

      const headings = screen.getAllByRole('heading', { hidden: true });
      expect(headings).toHaveLength(1);
      expect(headings[0].tagName).toBe('H1');
      expect(headings[0]).toHaveTextContent(SIGN_IN_ERROR_CONTENT.not_allowlisted.headline);
    });

    it('uses the same brand panel as the sign-in page', async () => {
      const { unmount } = renderView();
      const errorViewBrand = screen.getAllByText(APP_NAME, { exact: true }).length;
      unmount();

      render(<LoginPage />, { wrapperOptions: { authenticated: false } });
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /welcome/i })).toBeInTheDocument();
      });

      expect(screen.getAllByText(APP_NAME, { exact: true }).length).toBe(errorViewBrand);
      expect(screen.getByText(AUTH_TAGLINE, { ignore: '' })).toBeInTheDocument();
    });
  });

  describe('every code', () => {
    it.each(SIGN_IN_ERROR_CODES)('renders its headline, explanation and steps for %s', (code) => {
      renderView(code);
      const { headline, explanation, nextSteps } = SIGN_IN_ERROR_CONTENT[code];

      expect(screen.getByRole('heading', { level: 1, name: headline })).toBeInTheDocument();
      expect(screen.getByText(explanation)).toBeInTheDocument();
      for (const step of nextSteps) {
        expect(screen.getByText(step)).toBeInTheDocument();
      }
      expect(screen.getByRole('link', { name: /back to sign in/i })).toHaveAttribute(
        'href',
        '/login',
      );
    });

    it('keeps hyphenated compounds in the headline on one line without changing its text', () => {
      renderView('not_allowlisted');

      const heading = screen.getByRole('heading', {
        level: 1,
        name: SIGN_IN_ERROR_CONTENT.not_allowlisted.headline,
      });
      const compounds = Array.from(heading.querySelectorAll('span'));
      expect(compounds.map((span) => span.textContent)).toEqual(['invite-only']);
      expect(compounds[0]).toHaveStyle({ whiteSpace: 'nowrap' });
    });

    it.each(SIGN_IN_ERROR_CODES)(
      'does not add wrappers to a headline without a hyphen (%s)',
      (code) => {
        renderView(code);

        const { headline } = SIGN_IN_ERROR_CONTENT[code];
        const heading = screen.getByRole('heading', { level: 1, name: headline });
        const hyphenated = headline.match(/\S+-\S+/g) ?? [];
        expect(Array.from(heading.querySelectorAll('span')).map((s) => s.textContent)).toEqual(
          hyphenated,
        );
      },
    );

    it.each(SIGN_IN_ERROR_CODES)('announces %s with the right live region', (code) => {
      renderView(code);
      const isFault = SIGN_IN_ERROR_CONTENT[code].severity === 'error';

      expect(screen.queryByRole(isFault ? 'alert' : 'status')).toBeInTheDocument();
      expect(screen.queryByRole(isFault ? 'status' : 'alert')).not.toBeInTheDocument();
    });
  });

  describe('actions', () => {
    it('"Sign in with a different account" calls its handler for the allowlist case', async () => {
      const user = userEvent.setup();
      const { onSignInWithDifferentAccount, onTryAgain } = renderView('not_allowlisted');

      await user.click(screen.getByRole('button', { name: /sign in with a different account/i }));

      expect(onSignInWithDifferentAccount).toHaveBeenCalledTimes(1);
      expect(onTryAgain).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
    });

    it('offers the different-account action for a paused account', () => {
      renderView('account_disabled');

      expect(
        screen.getByRole('button', { name: /sign in with a different account/i }),
      ).toBeInTheDocument();
    });

    it('"Try again" calls its handler for a cancelled sign-in', async () => {
      const user = userEvent.setup();
      const { onSignInWithDifferentAccount, onTryAgain } = renderView('access_denied');

      await user.click(screen.getByRole('button', { name: /try again/i }));

      expect(onTryAgain).toHaveBeenCalledTimes(1);
      expect(onSignInWithDifferentAccount).not.toHaveBeenCalled();
    });

    it('offers only the way back for a misconfigured server', () => {
      renderView('server_misconfigured');

      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: /back to sign in/i })).toBeInTheDocument();
    });
  });

  describe('accessibility', () => {
    it('moves focus to the heading', async () => {
      renderView('not_allowlisted');

      const heading = screen.getByRole('heading', { level: 1 });
      await waitFor(() => expect(heading).toHaveFocus());
    });
  });
});
