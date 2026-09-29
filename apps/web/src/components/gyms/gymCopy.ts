/** Shared copy for the gym pages (E3.3). */
export const GYMS_TITLE = 'Gyms';
export const GYMS_SUBTITLE = 'Where you train and what is available there.';

export function deleteGymMessage(name: string, photoCount: number): string {
  const photos =
    photoCount > 0 ? ` and its ${photoCount === 1 ? 'photo' : `${photoCount} photos`}` : '';
  return `Delete "${name}" with its equipment list${photos}? This cannot be undone.`;
}
