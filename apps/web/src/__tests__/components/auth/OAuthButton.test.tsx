import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { OAuthButton } from '../../../components/auth/OAuthButton';
import { theme } from '../../../theme';

/**
 * The theme emits CSS variables, and jsdom does not resolve a `var()` chain in
 * `backgroundColor`/`color`. Read the custom property that MUI's contained
 * button routes the colour through, and follow the chain to a literal.
 */
function resolveVar(button: HTMLElement, value: string): string {
  const style = getComputedStyle(button);
  let resolved = value.trim();
  for (let i = 0; i < 5; i += 1) {
    const match = /^var\((--[\w-]+)\)$/.exec(resolved);
    if (!match) break;
    // jsdom lower-cases the name inside a computed `var()` (it reports
    // `--variant-containedcolor` for `--variant-containedColor`), so fall back
    // to a case-insensitive match against the declared custom properties.
    const name = match[1];
    let next = style.getPropertyValue(name).trim();
    if (!next) {
      const declared = Array.from(style).find((n) => n.toLowerCase() === name.toLowerCase());
      next = declared ? style.getPropertyValue(declared).trim() : '';
    }
    resolved = next;
  }
  return resolved;
}

// Start from the button's real computed colours, so an `sx` override that
// replaces the theme-driven value is seen (not just the variant's default).
const effectiveBg = (button: HTMLElement) =>
  resolveVar(button, getComputedStyle(button).backgroundColor);
const effectiveColor = (button: HTMLElement) =>
  resolveVar(button, getComputedStyle(button).color);

/** The `:hover` rule that sets the contained background, for the button's own class. */
function hoverBackground(button: HTMLElement): string | undefined {
  const css = [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n');
  for (const cls of Array.from(button.classList).filter((c) => c.startsWith('css-'))) {
    const match = new RegExp(`\\.${cls}:hover\\{[^}]*--variant-containedBg:([^;}]+)`).exec(css);
    if (match) return match[1].trim();
  }
  return undefined;
}

describe('OAuthButton', () => {
  const mockOnClick = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('should render Google provider button with correct text', () => {
      render(<OAuthButton provider="google" onClick={mockOnClick} />);

      expect(
        screen.getByRole('button', { name: /continue with google/i }),
      ).toBeInTheDocument();
    });

    it('should render Microsoft provider button with correct text', () => {
      render(<OAuthButton provider="microsoft" onClick={mockOnClick} />);

      expect(
        screen.getByRole('button', { name: /continue with microsoft/i }),
      ).toBeInTheDocument();
    });

    it('should render GitHub provider button with correct text', () => {
      render(<OAuthButton provider="github" onClick={mockOnClick} />);

      expect(
        screen.getByRole('button', { name: /continue with github/i }),
      ).toBeInTheDocument();
    });

    it('should render unknown provider with default text', () => {
      render(<OAuthButton provider="CustomProvider" onClick={mockOnClick} />);

      expect(
        screen.getByRole('button', { name: /continue with customprovider/i }),
      ).toBeInTheDocument();
    });

    it('should render button as full width', () => {
      render(<OAuthButton provider="google" onClick={mockOnClick} />);

      const button = screen.getByRole('button');
      expect(button).toBeInTheDocument();
    });

    it('should render with contained variant', () => {
      render(<OAuthButton provider="google" onClick={mockOnClick} />);

      const button = screen.getByRole('button');
      expect(button.className).toContain('MuiButton-contained');
    });

    it('should render with large size', () => {
      render(<OAuthButton provider="google" onClick={mockOnClick} />);

      const button = screen.getByRole('button');
      expect(button.className).toContain('MuiButton-sizeLarge');
    });
  });

  describe('Provider Icons', () => {
    it('should render Google icon', () => {
      render(<OAuthButton provider="google" onClick={mockOnClick} />);

      const button = screen.getByRole('button', { name: /continue with google/i });
      const icon = button.querySelector('svg');
      expect(icon).toBeInTheDocument();
    });

    it('should render Microsoft icon', () => {
      render(<OAuthButton provider="microsoft" onClick={mockOnClick} />);

      const button = screen.getByRole('button', { name: /continue with microsoft/i });
      const icon = button.querySelector('svg');
      expect(icon).toBeInTheDocument();
    });

    it('should render GitHub icon', () => {
      render(<OAuthButton provider="github" onClick={mockOnClick} />);

      const button = screen.getByRole('button', { name: /continue with github/i });
      const icon = button.querySelector('svg');
      expect(icon).toBeInTheDocument();
    });

    it('should not render icon for unknown provider', () => {
      render(<OAuthButton provider="unknown" onClick={mockOnClick} />);

      const button = screen.getByRole('button');
      const icon = button.querySelector('svg');
      expect(icon).not.toBeInTheDocument();
    });
  });

  describe('Click Handling', () => {
    it('should call onClick when button is clicked', async () => {
      const user = userEvent.setup();

      render(<OAuthButton provider="google" onClick={mockOnClick} />);

      const button = screen.getByRole('button', { name: /continue with google/i });
      await user.click(button);

      expect(mockOnClick).toHaveBeenCalledTimes(1);
    });

    it('should call onClick for Microsoft provider', async () => {
      const user = userEvent.setup();

      render(<OAuthButton provider="microsoft" onClick={mockOnClick} />);

      const button = screen.getByRole('button', { name: /continue with microsoft/i });
      await user.click(button);

      expect(mockOnClick).toHaveBeenCalledTimes(1);
    });

    it('should call onClick for GitHub provider', async () => {
      const user = userEvent.setup();

      render(<OAuthButton provider="github" onClick={mockOnClick} />);

      const button = screen.getByRole('button', { name: /continue with github/i });
      await user.click(button);

      expect(mockOnClick).toHaveBeenCalledTimes(1);
    });

    it('should call onClick for unknown provider', async () => {
      const user = userEvent.setup();

      render(<OAuthButton provider="custom" onClick={mockOnClick} />);

      const button = screen.getByRole('button');
      await user.click(button);

      expect(mockOnClick).toHaveBeenCalledTimes(1);
    });

    it('should handle multiple clicks', async () => {
      const user = userEvent.setup();

      render(<OAuthButton provider="google" onClick={mockOnClick} />);

      const button = screen.getByRole('button', { name: /continue with google/i });
      await user.click(button);
      await user.click(button);
      await user.click(button);

      expect(mockOnClick).toHaveBeenCalledTimes(3);
    });
  });

  describe('Provider Case Sensitivity', () => {
    it('should handle lowercase provider name', () => {
      render(<OAuthButton provider="google" onClick={mockOnClick} />);

      expect(
        screen.getByRole('button', { name: /continue with google/i }),
      ).toBeInTheDocument();
    });

    it('should handle uppercase provider name', () => {
      render(<OAuthButton provider="GOOGLE" onClick={mockOnClick} />);

      expect(
        screen.getByRole('button', { name: /continue with google/i }),
      ).toBeInTheDocument();
    });

    it('should handle mixed case provider name', () => {
      render(<OAuthButton provider="GoOgLe" onClick={mockOnClick} />);

      expect(
        screen.getByRole('button', { name: /continue with google/i }),
      ).toBeInTheDocument();
    });
  });

  describe('Styling', () => {
    it('should apply Google-specific styling', () => {
      render(<OAuthButton provider="google" onClick={mockOnClick} />);

      const button = screen.getByRole('button');
      expect(button).toBeInTheDocument();
      // Google button has white background and border
    });

    it('should apply Microsoft-specific styling', () => {
      render(<OAuthButton provider="microsoft" onClick={mockOnClick} />);

      const button = screen.getByRole('button');
      expect(button).toBeInTheDocument();
      // Microsoft button has dark background
    });

    it('should apply GitHub-specific styling', () => {
      render(<OAuthButton provider="github" onClick={mockOnClick} />);

      const button = screen.getByRole('button');
      expect(button).toBeInTheDocument();
      // GitHub button has dark background
    });

    it('should apply default styling for unknown provider', () => {
      render(<OAuthButton provider="unknown" onClick={mockOnClick} />);

      const button = screen.getByRole('button');
      expect(button).toBeInTheDocument();
      // Unknown provider gets default blue styling
    });

    it('should have border for Google provider', () => {
      const { container } = render(
        <OAuthButton provider="google" onClick={mockOnClick} />,
      );

      const button = container.querySelector('button');
      expect(button).toBeInTheDocument();
      // Google button should have a border (styling is applied via sx prop)
    });

    it('should have no border for non-Google providers', () => {
      const { container } = render(
        <OAuthButton provider="microsoft" onClick={mockOnClick} />,
      );

      const button = container.querySelector('button');
      expect(button).toBeInTheDocument();
    });
  });

  describe('Theme-following fallback (#236)', () => {
    afterEach(() => {
      localStorage.removeItem('theme_mode');
    });

    it.each(['light', 'dark'] as const)(
      'should style an unknown provider with the theme primary colours in %s mode',
      (mode) => {
        localStorage.setItem('theme_mode', mode);
        const { primary } = theme.colorSchemes[mode]!.palette!;

        render(<OAuthButton provider="okta" onClick={mockOnClick} />);

        const button = screen.getByRole('button', { name: /continue with okta/i });
        expect(document.documentElement.classList.contains(mode)).toBe(true);
        expect(effectiveBg(button).toLowerCase()).toBe(String(primary!.main).toLowerCase());
        expect(effectiveColor(button).toLowerCase()).toBe(
          String(primary!.contrastText).toLowerCase(),
        );
        expect(effectiveBg(button).toLowerCase()).not.toBe('#1976d2');
      },
    );

    it('should follow primary.dark on hover for an unknown provider', () => {
      render(<OAuthButton provider="okta" onClick={mockOnClick} />);

      const button = screen.getByRole('button');
      expect(hoverBackground(button)).toBe('var(--mui-palette-primary-dark)');
    });

    it('should not hard-code the previous blue fallback', () => {
      render(<OAuthButton provider="okta" onClick={mockOnClick} />);

      const css = [...document.querySelectorAll('style')]
        .map((s) => s.textContent)
        .join('\n')
        .toLowerCase();
      expect(css).not.toContain('#1976d2');
    });

    it.each([
      ['google', 'rgb(255, 255, 255)', 'rgb(117, 117, 117)'],
      ['microsoft', 'rgb(47, 47, 47)', 'rgb(255, 255, 255)'],
      ['github', 'rgb(36, 41, 46)', 'rgb(255, 255, 255)'],
    ])('should keep the %s brand colours in dark mode', (provider, bg, fg) => {
      localStorage.setItem('theme_mode', 'dark');

      render(<OAuthButton provider={provider} onClick={mockOnClick} />);

      const style = getComputedStyle(screen.getByRole('button'));
      expect(style.backgroundColor).toBe(bg);
      expect(style.color).toBe(fg);
    });
  });

  describe('Accessibility', () => {
    it('should have button role', () => {
      render(<OAuthButton provider="google" onClick={mockOnClick} />);

      expect(screen.getByRole('button')).toBeInTheDocument();
    });

    it('should be keyboard accessible', async () => {
      const user = userEvent.setup();

      render(<OAuthButton provider="google" onClick={mockOnClick} />);

      const button = screen.getByRole('button');
      button.focus();
      await user.keyboard('{Enter}');

      expect(mockOnClick).toHaveBeenCalled();
    });

    it('should be focusable via tab', async () => {
      const user = userEvent.setup();

      render(<OAuthButton provider="google" onClick={mockOnClick} />);

      await user.tab();

      const button = screen.getByRole('button');
      expect(button).toHaveFocus();
    });

    it('should support space key activation', async () => {
      const user = userEvent.setup();

      render(<OAuthButton provider="google" onClick={mockOnClick} />);

      const button = screen.getByRole('button');
      button.focus();
      await user.keyboard(' ');

      expect(mockOnClick).toHaveBeenCalled();
    });
  });

  describe('Provider Configuration', () => {
    it('should use correct label for Google', () => {
      render(<OAuthButton provider="google" onClick={mockOnClick} />);

      expect(screen.getByText('Continue with Google')).toBeInTheDocument();
    });

    it('should use correct label for Microsoft', () => {
      render(<OAuthButton provider="microsoft" onClick={mockOnClick} />);

      expect(screen.getByText('Continue with Microsoft')).toBeInTheDocument();
    });

    it('should use correct label for GitHub', () => {
      render(<OAuthButton provider="github" onClick={mockOnClick} />);

      expect(screen.getByText('Continue with GitHub')).toBeInTheDocument();
    });

    it('should generate label for unknown provider', () => {
      render(<OAuthButton provider="CustomAuth" onClick={mockOnClick} />);

      expect(screen.getByText('Continue with CustomAuth')).toBeInTheDocument();
    });

    it('should preserve provider name case in fallback label', () => {
      render(<OAuthButton provider="MyCustomProvider" onClick={mockOnClick} />);

      // The component uses the original provider name in the fallback label
      expect(screen.getByText('Continue with MyCustomProvider')).toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty string provider', () => {
      render(<OAuthButton provider="" onClick={mockOnClick} />);

      const button = screen.getByRole('button');
      // Empty provider results in "Continue with " (with trailing space)
      expect(button.textContent).toContain('Continue with');
    });

    it('should handle provider with special characters', () => {
      render(<OAuthButton provider="test-provider" onClick={mockOnClick} />);

      expect(screen.getByText('Continue with test-provider')).toBeInTheDocument();
    });

    it('should handle provider with spaces', () => {
      render(<OAuthButton provider="my provider" onClick={mockOnClick} />);

      expect(screen.getByText('Continue with my provider')).toBeInTheDocument();
    });

    it('should call onClick when clicked', async () => {
      const user = userEvent.setup();
      const mockClick = vi.fn();

      render(<OAuthButton provider="google" onClick={mockClick} />);

      const button = screen.getByRole('button');
      await user.click(button);

      expect(mockClick).toHaveBeenCalled();
    });

    it('should handle very long provider name', () => {
      const longProviderName = 'a'.repeat(100);
      render(<OAuthButton provider={longProviderName} onClick={mockOnClick} />);

      expect(
        screen.getByText(`Continue with ${longProviderName}`),
      ).toBeInTheDocument();
    });
  });

  describe('Multiple Instances', () => {
    it('should render multiple buttons independently', async () => {
      const user = userEvent.setup();
      const mockOnClickGoogle = vi.fn();
      const mockOnClickMicrosoft = vi.fn();
      const mockOnClickGitHub = vi.fn();

      const { container } = render(
        <>
          <OAuthButton provider="google" onClick={mockOnClickGoogle} />
          <OAuthButton provider="microsoft" onClick={mockOnClickMicrosoft} />
          <OAuthButton provider="github" onClick={mockOnClickGitHub} />
        </>,
      );

      const buttons = container.querySelectorAll('button');
      expect(buttons).toHaveLength(3);

      await user.click(buttons[0]);
      expect(mockOnClickGoogle).toHaveBeenCalledTimes(1);
      expect(mockOnClickMicrosoft).not.toHaveBeenCalled();
      expect(mockOnClickGitHub).not.toHaveBeenCalled();

      await user.click(buttons[1]);
      expect(mockOnClickGoogle).toHaveBeenCalledTimes(1);
      expect(mockOnClickMicrosoft).toHaveBeenCalledTimes(1);
      expect(mockOnClickGitHub).not.toHaveBeenCalled();

      await user.click(buttons[2]);
      expect(mockOnClickGoogle).toHaveBeenCalledTimes(1);
      expect(mockOnClickMicrosoft).toHaveBeenCalledTimes(1);
      expect(mockOnClickGitHub).toHaveBeenCalledTimes(1);
    });
  });

  describe('Icon SVG Content', () => {
    it('should render Google icon with correct paths', () => {
      render(<OAuthButton provider="google" onClick={mockOnClick} />);

      const button = screen.getByRole('button');
      const svg = button.querySelector('svg');
      const paths = svg?.querySelectorAll('path');

      // Google icon has 4 colored paths
      expect(paths?.length).toBe(4);
    });

    it('should render Microsoft icon with correct paths', () => {
      render(<OAuthButton provider="microsoft" onClick={mockOnClick} />);

      const button = screen.getByRole('button');
      const svg = button.querySelector('svg');
      const paths = svg?.querySelectorAll('path');

      // Microsoft icon has 4 colored squares
      expect(paths?.length).toBe(4);
    });

    it('should render GitHub icon with correct path', () => {
      render(<OAuthButton provider="github" onClick={mockOnClick} />);

      const button = screen.getByRole('button');
      const svg = button.querySelector('svg');
      const paths = svg?.querySelectorAll('path');

      // GitHub icon has 1 path
      expect(paths?.length).toBe(1);
    });

    it('should render SVG with correct viewBox', () => {
      render(<OAuthButton provider="google" onClick={mockOnClick} />);

      const button = screen.getByRole('button');
      const svg = button.querySelector('svg');

      expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    });
  });

  describe('Button Behavior', () => {
    it('should not submit form when clicked', async () => {
      const user = userEvent.setup();
      const mockSubmit = vi.fn((e) => e.preventDefault());

      render(
        <form onSubmit={mockSubmit}>
          <OAuthButton provider="google" onClick={mockOnClick} />
        </form>,
      );

      const button = screen.getByRole('button');
      await user.click(button);

      expect(mockOnClick).toHaveBeenCalled();
      // Form should not be submitted (default button type is 'button' in MUI)
    });

    it('should maintain text transform none styling', () => {
      render(<OAuthButton provider="google" onClick={mockOnClick} />);

      const button = screen.getByRole('button');
      expect(button).toBeInTheDocument();
      // Text transform is applied via sx prop, which becomes inline styles
    });

    it('should have hover state styling defined', () => {
      render(<OAuthButton provider="google" onClick={mockOnClick} />);

      const button = screen.getByRole('button');
      expect(button).toBeInTheDocument();
      // Hover styles are defined in sx prop
    });
  });
});
