/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Primary brand blue used across buttons, links and focus rings.
        brand: {
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
          800: '#1e40af',
        },
        /*
          ONE NEUTRAL SCALE FOR EVERY RULE ON THE PAGE, so a field, a table and
          a panel are bounded by the same family of greys instead of whichever
          slate the file happened to use.

            line-subtle   row separators inside an already-bounded table
            line          table, card and panel shells; header rules
            line-strong   what the user types into or presses: inputs, selects,
                          textareas, outlined buttons

          ONE STEP DARKER THAN THE FIRST VERSION (slate-200/300/400), at the
          operators' repeated request: at desk distance the old greys let a
          table, its neighbour and the page background run together. These are
          medium greys — clearly visible, never black — and a hover on a field
          goes one step further (slate-600).
        */
        line: {
          subtle: '#cbd5e1',
          DEFAULT: '#94a3b8',
          strong: '#64748b',
        },
      },
      /*
        THE TWO WEIGHTS OF A REPORT, paired with the `line` colours above:

          section   3px   the outer frame of a report section, table or card,
                          so one table, the next and the page never run together
          rule      2px   the rules inside it: under a header, between rows,
                          above a footer

        Fields keep their 1px `line-strong` edge; the colour carries them.
      */
      borderWidth: {
        section: '3px',
        rule: '2px',
      },
      borderRadius: {
        xl: '12px',
        '2xl': '16px',
      },
      fontFamily: {
        sans: [
          'Inter',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
};
