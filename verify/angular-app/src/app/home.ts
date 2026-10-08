import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { SeamlessAuth } from '@seamless-auth/angular';

// The accessible names here ("Open account menu", "Logout", "You are signed in")
// are a cross-repo contract with the browser specs, shared with the React
// template.
@Component({
  selector: 'app-home',
  template: `
    <header>
      <button
        type="button"
        aria-label="Open account menu"
        [attr.aria-expanded]="menuOpen()"
        (click)="menuOpen.set(!menuOpen())"
      >
        {{ identity() }}
      </button>
      @if (menuOpen()) {
        <div>
          <button type="button" (click)="logout()">Logout</button>
        </div>
      }
    </header>
    <main>
      <h1>You are signed in</h1>
      <p>Signed in as {{ identity() }}.</p>
    </main>
  `,
})
export class Home {
  private readonly auth = inject(SeamlessAuth);
  private readonly router = inject(Router);

  readonly menuOpen = signal(false);
  readonly identity = computed(() => {
    const user = this.auth.user();
    return user?.email || user?.phone || 'you';
  });

  async logout() {
    await this.auth.logout();
    await this.router.navigateByUrl('/login');
  }
}
