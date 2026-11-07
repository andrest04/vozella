// Page layout recipe. The widths are tokens (styles/index.css): --container-page for the page,
// --container-reading (max-w-reading) for reading text such as the summary and the transcript.

/**
 * The column every page except the Library sits in: centered, the page padding outside the
 * content, and the content capped at the page width (1152 px). Below the cap it is today's
 * column: full width with the same padding, so narrow windows do not change. The cap adds the
 * two px-10 paddings in spacing units, so it holds whatever the root font size is.
 */
export const pageColumn =
  'mx-auto w-full max-w-[calc(var(--container-page)+var(--spacing)*20)] px-10 pt-8';
