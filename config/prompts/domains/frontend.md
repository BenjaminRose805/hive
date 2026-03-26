# Frontend Domain Knowledge

Domain-specific knowledge for agents working on user interfaces, client-side logic, and browser-based applications. This content is role-agnostic — it applies whether you are designing, building, testing, or reviewing frontend code.

## Component Architecture

- **Composition over inheritance**: Build UIs by composing small, focused components. Each component should do one thing well.
- **Single responsibility**: A component either manages state OR renders UI. Components that do both become hard to test and reuse.
- **Props down, events up**: Data flows down through props. User actions flow up through events/callbacks. Avoid reaching into child component internals.
- **Colocation**: Keep related code together. Styles, tests, and types for a component should live near the component file.
- **Reusable vs specific**: Not every component needs to be reusable. Build specific components for specific views. Extract reusable ones only when the pattern repeats.

## State Management

- **Minimize global state**: Most state is local to a component or a small subtree. Global state should be reserved for truly global concerns (auth, theme, feature flags).
- **Colocate state**: Keep state as close as possible to where it is used. Lifting state up is better than global stores for most cases.
- **Derived state**: Compute derived values from existing state rather than storing them separately. Stored derived state gets out of sync.
- **Server state**: Data fetched from APIs is server state, not client state. Use dedicated tools (React Query, SWR, Apollo) that handle caching, revalidation, and loading states.
- **URL as state**: For anything that should be shareable or bookmarkable (filters, pagination, search), use URL parameters as the source of truth.

## Accessibility (WCAG 2.1 AA)

- **Semantic HTML**: Use `<button>`, `<nav>`, `<main>`, `<article>`, `<header>`, `<footer>`. Semantic elements provide free accessibility. Divs with click handlers are not buttons.
- **ARIA attributes**: Use ARIA only when semantic HTML is insufficient. `aria-label` for icon buttons, `aria-live` for dynamic content, `role` when repurposing elements.
- **Keyboard navigation**: Every interactive element must be reachable and operable via keyboard. Tab order should follow visual order. Focus traps for modals.
- **Color contrast**: Text must meet 4.5:1 contrast ratio (3:1 for large text). Do not rely on color alone to convey information.
- **Screen reader testing**: Test with a screen reader. Ensure images have alt text, form fields have labels, and dynamic content updates are announced.

## Responsive Design

- **Mobile-first**: Start with the smallest viewport and add complexity for larger screens. This forces you to prioritize content.
- **Fluid layouts**: Use relative units (%, rem, vh/vw) and CSS Grid/Flexbox. Avoid fixed pixel widths for layout containers.
- **Breakpoints**: Set breakpoints based on content needs, not device sizes. When the layout breaks, add a breakpoint.
- **Touch targets**: Interactive elements should be at least 44x44px for touch. Spacing between targets prevents accidental taps.

## Performance

- **Bundle size**: Monitor bundle size. Use code splitting and lazy loading for routes and heavy components. Tree-shake unused code.
- **Lazy loading**: Load images, components, and routes on demand. Use `loading="lazy"` for images below the fold. Use dynamic imports for route-level code splitting.
- **Rendering performance**: Avoid unnecessary re-renders. Memoize expensive computations. Use virtualization for long lists (hundreds+ items).
- **Core Web Vitals**: Monitor LCP (Largest Contentful Paint), FID (First Input Delay), and CLS (Cumulative Layout Shift). These affect user experience and SEO.
- **Asset optimization**: Compress images (WebP/AVIF), minify CSS/JS, use CDN for static assets, set appropriate cache headers.

## Common Pitfalls

- **Memory leaks**: Clean up event listeners, timers, and subscriptions when components unmount. Leaked subscriptions cause stale state updates.
- **Prop drilling**: Passing props through many layers. Use context, composition patterns, or state management before adding a global store.
- **Premature abstraction**: Do not create a shared component until you have at least two concrete use cases. Wrong abstractions are worse than duplication.
- **Ignoring loading/error states**: Every async operation has loading, success, error, and empty states. Handle all four.
