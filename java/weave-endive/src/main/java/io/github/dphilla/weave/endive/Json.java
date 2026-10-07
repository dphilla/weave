package io.github.dphilla.weave.endive;

import java.util.LinkedHashMap;
import java.util.Map;

/** The strict JSON subset control requests use: one flat object of string, integer and null values. */
final class Json {
    /** An integer token kept verbatim, so range checks need no rounding. */
    static final class Num {
        final String token;

        Num(String token) {
            this.token = token;
        }
    }

    private final String s;
    private int pos;

    private Json(String s) {
        this.s = s;
    }

    static Map<String, Object> parseObject(byte[] utf8) {
        Json p = new Json(Bytes.utf8(utf8, 0, utf8.length));
        Map<String, Object> out = new LinkedHashMap<>();
        p.ws();
        p.expect('{');
        p.ws();
        if (p.peek() == '}') {
            p.pos++;
        } else {
            char c;
            do {
                p.ws();
                String key = p.string();
                p.ws();
                p.expect(':');
                p.ws();
                if (out.containsKey(key)) {
                    throw new FormatException("duplicate field " + key);
                }
                out.put(key, p.value());
                p.ws();
                c = p.next();
            } while (c == ',');
            if (c != '}') {
                throw new FormatException("expected ',' or '}'");
            }
        }
        p.ws();
        if (p.pos != p.s.length()) {
            throw new FormatException("trailing characters after JSON object");
        }
        return out;
    }

    private Object value() {
        char c = peek();
        if (c == '"') {
            return string();
        }
        if (s.startsWith("null", pos)) {
            pos += 4;
            return null;
        }
        if (c != '-' && (c < '0' || c > '9')) {
            throw new FormatException("unsupported JSON value");
        }
        int start = pos;
        pos += c == '-' ? 1 : 0;
        if (peek() == '0') {
            pos++;
        } else if (peek() >= '1' && peek() <= '9') {
            while (peek() >= '0' && peek() <= '9') {
                pos++;
            }
        } else {
            throw new FormatException("invalid number");
        }
        if (peek() == '.' || peek() == 'e' || peek() == 'E') {
            throw new FormatException("expected an integer");
        }
        return new Num(s.substring(start, pos));
    }

    private String string() {
        expect('"');
        StringBuilder sb = new StringBuilder();
        for (char c = next(); c != '"'; c = next()) {
            if (c < 0x20) {
                throw new FormatException("control character in string");
            }
            if (c == '\\') {
                int escape = "\"\\/bfnrtu".indexOf(next());
                if (escape < 0) {
                    throw new FormatException("invalid escape");
                }
                c = escape < 8 ? "\"\\/\b\f\n\r\t".charAt(escape) : (char) hex4();
            }
            sb.append(c);
        }
        String out = sb.toString();
        for (int i = 0; i < out.length(); i++) {
            if (Character.isHighSurrogate(out.charAt(i))
                    && i + 1 < out.length()
                    && Character.isLowSurrogate(out.charAt(i + 1))) {
                i++;
            } else if (Character.isSurrogate(out.charAt(i))) {
                throw new FormatException("lone surrogate in string");
            }
        }
        return out;
    }

    private int hex4() {
        int v = 0;
        for (int i = 0; i < 4; i++) {
            char c = next();
            int d = c < 128 ? Character.digit(c, 16) : -1;
            if (d < 0) {
                throw new FormatException("invalid unicode escape");
            }
            v = v * 16 + d;
        }
        return v;
    }

    private void ws() {
        while (pos < s.length() && " \t\n\r".indexOf(s.charAt(pos)) >= 0) {
            pos++;
        }
    }

    private char peek() {
        return pos < s.length() ? s.charAt(pos) : '\0';
    }

    private char next() {
        if (pos >= s.length()) {
            throw new FormatException("truncated JSON");
        }
        return s.charAt(pos++);
    }

    private void expect(char c) {
        if (next() != c) {
            throw new FormatException("expected '" + c + "'");
        }
    }

    static String quote(String v) {
        StringBuilder sb = new StringBuilder("\"");
        for (char c : v.toCharArray()) {
            if (c == '"' || c == '\\') {
                sb.append('\\').append(c);
            } else if (c < 0x20) {
                sb.append(String.format("\\u%04x", (int) c));
            } else {
                sb.append(c);
            }
        }
        return sb.append('"').toString();
    }
}
