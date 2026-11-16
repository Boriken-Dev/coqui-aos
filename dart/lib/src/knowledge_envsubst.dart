/// The one place an `envsubst` file's text is rendered, so the engine can be swapped without
/// touching how a file is found, counted or served.
library;

import 'template.dart';

/// [text] with each `${NAME}` that [values] holds replaced; every other text is itself.
String renderEnvsubst(String text, Map<String, String> values) =>
    template(text, values);
