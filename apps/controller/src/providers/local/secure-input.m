#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#include <errno.h>
#include <math.h>
#include <signal.h>
#include <stdint.h>
#include <unistd.h>

static const NSUInteger maximumFrameBytes = 32768;

static BOOL readAll(int descriptor, void *bytes, size_t length) {
  uint8_t *cursor = bytes;
  while (length) {
    ssize_t count = read(descriptor, cursor, length);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return NO;
    cursor += count;
    length -= (size_t)count;
  }
  return YES;
}

static BOOL writeAll(int descriptor, const void *bytes, size_t length) {
  const uint8_t *cursor = bytes;
  while (length) {
    ssize_t count = write(descriptor, cursor, length);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return NO;
    cursor += count;
    length -= (size_t)count;
  }
  return YES;
}

static BOOL keysEqual(id value, NSArray<NSString *> *keys) {
  return [value isKindOfClass:[NSDictionary class]] &&
    [[NSSet setWithArray:[value allKeys]] isEqualToSet:[NSSet setWithArray:keys]];
}

static BOOL matches(id value, NSString *pattern) {
  if (![value isKindOfClass:[NSString class]]) return NO;
  NSRegularExpression *expression =
    [NSRegularExpression regularExpressionWithPattern:pattern options:0 error:NULL];
  NSTextCheckingResult *result =
    [expression firstMatchInString:value options:0 range:NSMakeRange(0, [value length])];
  return result && NSEqualRanges(result.range, NSMakeRange(0, [value length]));
}

static BOOL integerInRange(id value, double minimum, double maximum) {
  if (![value isKindOfClass:[NSNumber class]] ||
      CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) return NO;
  double number = [value doubleValue];
  return isfinite(number) && floor(number) == number && number >= minimum && number <= maximum;
}

static BOOL boundedSecret(NSString *value) {
  NSData *bytes = [value dataUsingEncoding:NSUTF8StringEncoding allowLossyConversion:NO];
  NSMutableCharacterSet *forbidden = [[NSCharacterSet newlineCharacterSet] mutableCopy];
  [forbidden addCharactersInRange:NSMakeRange(0, 1)];
  return bytes && bytes.length <= 4096 && value.length <= 4096 &&
    [value rangeOfCharacterFromSet:forbidden].location == NSNotFound;
}

static BOOL validSecret(NSString *value) {
  return boundedSecret(value) &&
    [value stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]].length > 0;
}

@interface LocalInputFormatter : NSFormatter
@end

@implementation LocalInputFormatter
- (NSString *)stringForObjectValue:(id)value {
  return [value isKindOfClass:[NSString class]] ? value : @"";
}
- (BOOL)getObjectValue:(id *)object forString:(NSString *)value errorDescription:(NSString **)error {
  if (!boundedSecret(value)) return NO;
  if (object) *object = value;
  return YES;
}
- (BOOL)isPartialStringValid:(NSString *)value
           newEditingString:(NSString **)edited
           errorDescription:(NSString **)error {
  return boundedSecret(value);
}
@end

@interface LocalInputDelegate : NSObject <NSTextFieldDelegate>
@property(nonatomic, weak) NSButton *connectButton;
@end

@implementation LocalInputDelegate
- (void)controlTextDidChange:(NSNotification *)notification {
  self.connectButton.enabled = validSecret([notification.object stringValue]);
}
@end

int main(void) {
  @autoreleasepool {
    signal(SIGPIPE, SIG_IGN);
    uint8_t header[4];
    if (!readAll(STDIN_FILENO, header, sizeof(header))) return 1;
    uint32_t length = ((uint32_t)header[0] << 24) | ((uint32_t)header[1] << 16) |
      ((uint32_t)header[2] << 8) | header[3];
    if (length == 0 || length > maximumFrameBytes) return 1;
    NSMutableData *input = [NSMutableData dataWithLength:length];
    if (!readAll(STDIN_FILENO, input.mutableBytes, length)) return 1;
    id request = [NSJSONSerialization JSONObjectWithData:input options:0 error:NULL];
    if (!keysEqual(request, @[@"binding", @"endpoint", @"timeoutMs"])) return 1;
    NSDictionary *binding = request[@"binding"];
    BOOL legacy = keysEqual(binding, @[@"version", @"operationId", @"nonce", @"connectionHash", @"setupHash", @"revision"]) &&
      integerInRange(binding[@"version"], 1, 1) &&
      integerInRange(binding[@"revision"], 0, 9007199254740991.0) &&
      matches(binding[@"setupHash"], @"^[a-f0-9]{64}$");
    BOOL configured = keysEqual(binding, @[@"version", @"operationId", @"nonce", @"connectionHash", @"connectionRevision"]) &&
      integerInRange(binding[@"version"], 2, 2) &&
      integerInRange(binding[@"connectionRevision"], 0, 9007199254740991.0);
    if ((!legacy && !configured) ||
        !matches(binding[@"operationId"], @"^cmd_[0-7][0-9A-HJKMNP-TV-Z]{25}$") ||
        !matches(binding[@"nonce"], @"^[a-f0-9]{64}$") ||
        !matches(binding[@"connectionHash"], @"^[a-f0-9]{64}$") ||
        !matches(request[@"endpoint"], @"^ws://127\\.0\\.0\\.1:([1-9][0-9]{0,4})$") ||
        !integerInRange(request[@"timeoutMs"], 1, 60000)) return 1;
    NSString *endpoint = request[@"endpoint"];
    NSInteger port = [[[endpoint componentsSeparatedByString:@":"] lastObject] integerValue];
    if (port < 1 || port > 65535) return 1;

    [NSApplication sharedApplication];
    if (![NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory]) return 1;
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"Connect Local";
    alert.informativeText = [NSString stringWithFormat:
      @"Endpoint %@\nThe connection secret stays in memory.", endpoint];
    [alert addButtonWithTitle:@"Connect"];
    [alert addButtonWithTitle:@"Cancel"];
    NSSecureTextField *field = [[NSSecureTextField alloc] initWithFrame:NSMakeRect(0, 0, 360, 24)];
    field.placeholderString = @"Dedicated connection secret";
    field.formatter = [[LocalInputFormatter alloc] init];
    [field setAccessibilityLabel:@"Local connection secret"];
    LocalInputDelegate * __attribute__((objc_precise_lifetime)) delegate = [[LocalInputDelegate alloc] init];
    delegate.connectButton = alert.buttons[0];
    delegate.connectButton.enabled = NO;
    field.delegate = delegate;
    alert.accessoryView = field;
    [alert layout];
    [alert.window setInitialFirstResponder:field];

    __block BOOL finished = NO;
    __block BOOL cancelled = NO;
    void (^cancel)(void) = ^{
      if (finished) return;
      cancelled = YES;
      [NSApp abortModal];
      [alert.window orderOut:nil];
    };
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      uint8_t extra;
      ssize_t count;
      do { count = read(STDIN_FILENO, &extra, 1); } while (count < 0 && errno == EINTR);
      dispatch_async(dispatch_get_main_queue(), cancel);
    });
    NSTimer *timer = [NSTimer timerWithTimeInterval:[request[@"timeoutMs"] doubleValue] / 1000.0
      repeats:NO block:^(NSTimer *value) { cancel(); }];
    [[NSRunLoop mainRunLoop] addTimer:timer forMode:NSRunLoopCommonModes];
    [[NSRunLoop mainRunLoop] addTimer:timer forMode:NSModalPanelRunLoopMode];
    [NSApp activateIgnoringOtherApps:YES];
    NSModalResponse response = [alert runModal];
    finished = YES;
    [timer invalidate];
    [alert.window makeFirstResponder:nil];
    NSString *secret = field.stringValue;
    BOOL submitted = response == NSAlertFirstButtonReturn && !cancelled && validSecret(secret);
    NSMutableDictionary *result = [@{ @"binding": binding,
      @"outcome": submitted ? @"submitted" : @"cancelled" } mutableCopy];
    if (submitted) result[@"secret"] = secret;
    NSData *output = [NSJSONSerialization dataWithJSONObject:result options:0 error:NULL];
    field.stringValue = @"";
    [alert.window orderOut:nil];
    if (!output || output.length == 0 || output.length > maximumFrameBytes) return 1;
    uint32_t outputLength = (uint32_t)output.length;
    uint8_t outputHeader[4] = { (uint8_t)(outputLength >> 24), (uint8_t)(outputLength >> 16),
      (uint8_t)(outputLength >> 8), (uint8_t)outputLength };
    return writeAll(3, outputHeader, sizeof(outputHeader)) && writeAll(3, output.bytes, output.length) ? 0 : 1;
  }
}
