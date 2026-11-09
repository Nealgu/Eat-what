using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Cache;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace FoodTime.Desktop
{
    internal sealed class NearbyService
    {
        private const string Endpoint = "https://overpass.private.coffee/api/interpreter";
        private const string UserAgent = "FoodTime/1.2.1 (+https://github.com/Nealgu/Eat-what)";
        private const int TimeoutMs = 15000;
        private const int MaxResponseBytes = 2 * 1024 * 1024;
        private const int ResultLimit = 25;
        private const int MaxRadiusMeters = 5000;
        // Rounding latitude and longitude to 0.01° can move the centre by up to 787 m.
        private const int GridPaddingMeters = 800;
        private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);
        private int searching;

        internal async Task<object> SearchAsync(double latitude, double longitude, int radiusMeters)
        {
            if (!IsCoordinate(latitude, longitude) || radiusMeters < 1 || radiusMeters > MaxRadiusMeters)
                throw new InvalidDataException("定位或搜索范围无效，请重新定位后再试。");

            if (Interlocked.Exchange(ref searching, 1) != 0)
                throw new InvalidDataException("正在查找附近餐馆，请稍等。");

            try
            {
                return await Task.Run<object>(() => Search(latitude, longitude, radiusMeters)).ConfigureAwait(false);
            }
            finally { Interlocked.Exchange(ref searching, 0); }
        }

        private static object Search(double latitude, double longitude, int radiusMeters)
        {
            IDictionary<string, object> response = QueryOverpass(BuildQuery(latitude, longitude, radiusMeters));
            return ReadRestaurants(response, latitude, longitude, radiusMeters);
        }

        private static string BuildQuery(double latitude, double longitude, int radiusMeters)
        {
            // Only send the rounded search centre. The actual location stays in this process.
            double gridLatitude = Math.Round(latitude, 2);
            double gridLongitude = Math.Round(longitude, 2);
            string area = String.Format(CultureInfo.InvariantCulture, "{0},{1:F2},{2:F2}",
                radiusMeters + GridPaddingMeters, gridLatitude, gridLongitude);
            return "[out:json][timeout:10][maxsize:67108864];" +
                "nwr[\"amenity\"~\"^(restaurant|fast_food|food_court|cafe)$\"][~\"^name(:zh(-.*)?)?$\"~\".\"](around:" +
                area + ");out body center qt 1500;";
        }

        private static IDictionary<string, object> QueryOverpass(string query)
        {
            // Keep coordinates in the POST body and discard response/error text after parsing.
            byte[] body = Encoding.ASCII.GetBytes("data=" + Uri.EscapeDataString(query));
            var request = (HttpWebRequest)WebRequest.Create(Endpoint);
            request.Method = "POST";
            request.UserAgent = UserAgent;
            request.AllowAutoRedirect = false;
            request.AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate;
            request.CachePolicy = new RequestCachePolicy(RequestCacheLevel.NoCacheNoStore);
            request.Timeout = TimeoutMs;
            request.ReadWriteTimeout = TimeoutMs;
            request.Accept = "application/json";
            request.ContentType = "application/x-www-form-urlencoded";
            request.ContentLength = body.Length;

            try
            {
                using (var deadline = new CancellationTokenSource(TimeoutMs))
                using (deadline.Token.Register(request.Abort))
                {
                    using (Stream upload = request.GetRequestStream())
                        upload.Write(body, 0, body.Length);

                    using (var response = (HttpWebResponse)request.GetResponse())
                    using (Stream stream = response.GetResponseStream())
                    {
                        if (response.StatusCode != HttpStatusCode.OK || stream == null)
                            throw new InvalidDataException("地图服务暂时不可用，请稍后重试。");
                        return ParseResponse(ReadLimited(stream));
                    }
                }
            }
            catch (WebException error)
            {
                using (var response = error.Response as HttpWebResponse)
                {
                    int status = response == null ? 0 : (int)response.StatusCode;
                    if (status == 429 || status == 503 || status == 504 ||
                        error.Status == WebExceptionStatus.Timeout || error.Status == WebExceptionStatus.RequestCanceled)
                        throw new InvalidDataException("地图服务繁忙或响应超时，请稍后重试或缩小搜索范围。");
                }
                throw new InvalidDataException("暂时连不上地图服务，请检查网络后重试。");
            }
            catch (IOException)
            {
                throw new InvalidDataException("未能读完地图结果，请稍后重试。");
            }
        }

        private static byte[] ReadLimited(Stream stream)
        {
            using (var buffer = new MemoryStream())
            {
                byte[] chunk = new byte[8192];
                int count;
                while ((count = stream.Read(chunk, 0, chunk.Length)) > 0)
                {
                    if (buffer.Length + count > MaxResponseBytes)
                        throw new InvalidDataException("附近地点数据过多，请缩小搜索范围。");
                    buffer.Write(chunk, 0, count);
                }
                return buffer.ToArray();
            }
        }

        private static IDictionary<string, object> ParseResponse(byte[] content)
        {
            IDictionary<string, object> data;
            try
            {
                var serializer = new JavaScriptSerializer { MaxJsonLength = MaxResponseBytes, RecursionLimit = 24 };
                data = serializer.DeserializeObject(StrictUtf8.GetString(content).TrimStart('\uFEFF')) as IDictionary<string, object>;
            }
            catch (ArgumentException)
            {
                throw new InvalidDataException("地图服务返回了无法读取的数据，请稍后重试。");
            }
            catch (InvalidOperationException)
            {
                throw new InvalidDataException("地图服务返回了无法读取的数据，请稍后重试。");
            }

            if (data == null || !(Field(data, "elements") is IList))
                throw new InvalidDataException("地图服务未返回有效的地点列表，请稍后重试。");
            if (Tag(data, "remark").Length > 0)
                throw new InvalidDataException("地图服务未能完成本次搜索，请稍后重试或缩小范围。");
            return data;
        }

        private sealed class Restaurant
        {
            internal string Id, Name, Address, Category, Note;
            internal double Latitude, Longitude, Distance;
        }

        private static object[] ReadRestaurants(IDictionary<string, object> data, double latitude, double longitude, int radiusMeters)
        {
            var candidates = new List<Restaurant>();
            var ids = new HashSet<string>(StringComparer.Ordinal);
            foreach (object value in (IList)Field(data, "elements"))
            {
                var element = value as IDictionary<string, object>;
                var tags = Field(element, "tags") as IDictionary<string, object>;
                string type = Tag(element, "type");
                string name = FirstTag(tags, "name:zh-Hans", "name:zh-CN", "name:zh", "name", "name:zh-Hant", "name:zh-TW", "name:zh-HK");
                string category = CategoryLabel(Tag(tags, "amenity"));
                string id;
                double poiLatitude, poiLongitude;
                if (category.Length == 0 || name.Length == 0 ||
                    !TryIdentity(element, type, out id) || !TryLocation(element, type, out poiLatitude, out poiLongitude))
                    continue;

                double distance = DistanceKm(latitude, longitude, poiLatitude, poiLongitude);
                if (distance * 1000 > radiusMeters || !ids.Add(id)) continue;
                candidates.Add(new Restaurant {
                    Id = id,
                    Name = Limit(name, 50),
                    Address = DescribeAddress(tags),
                    Category = category,
                    Note = Limit(FirstTag(tags, "description:zh", "description"), 80),
                    Latitude = poiLatitude,
                    Longitude = poiLongitude,
                    Distance = distance
                });
            }

            var closest = new List<Restaurant>();
            foreach (Restaurant candidate in candidates.OrderBy(item => item.Distance))
            {
                Restaurant duplicate = closest.Find(item => IsSameRestaurant(item, candidate));
                if (duplicate != null)
                {
                    if (duplicate.Address.Length == 0) duplicate.Address = candidate.Address;
                    if (duplicate.Note.Length == 0) duplicate.Note = candidate.Note;
                    continue;
                }
                closest.Add(candidate);
                if (closest.Count == ResultLimit) break;
            }

            return closest.Select(item => (object)new {
                id = item.Id,
                name = item.Name,
                address = item.Address,
                category = item.Category,
                distanceKm = Math.Max(0.001, item.Distance),
                budget = 0,
                note = item.Note,
                enabled = true
            }).ToArray();
        }

        private static bool IsSameRestaurant(Restaurant first, Restaurant second)
        {
            if (!String.Equals(first.Name, second.Name, StringComparison.OrdinalIgnoreCase) ||
                first.Category != second.Category) return false;

            if (first.Address.Length > 0 && second.Address.Length > 0 &&
                !String.Equals(first.Address, second.Address, StringComparison.OrdinalIgnoreCase)) return false;

            return DistanceKm(first.Latitude, first.Longitude, second.Latitude, second.Longitude) <= 0.025;
        }

        private static string CategoryLabel(string amenity)
        {
            switch (amenity)
            {
                case "restaurant": return "餐厅";
                case "fast_food": return "快餐";
                case "food_court": return "美食广场";
                case "cafe": return "咖啡馆";
                default: return String.Empty;
            }
        }

        private static string DescribeAddress(IDictionary<string, object> tags)
        {
            string address = Tag(tags, "addr:full");
            if (address.Length == 0)
            {
                string street = FirstTag(tags, "addr:street", "addr:place");
                string number = Tag(tags, "addr:housenumber");
                string streetAndNumber = String.Join(" ", new[] { street, number }.Where(part => part.Length > 0));
                address = String.Join(" · ", new[] { Tag(tags, "addr:city"),
                    FirstTag(tags, "addr:district", "addr:suburb"), streetAndNumber }.Where(part => part.Length > 0).Distinct());
            }

            address = AppendDetail(address, Tag(tags, "addr:housename"), String.Empty);
            address = AppendDetail(address, FirstTag(tags, "addr:floor", "floor", "level"), "楼层 ");
            address = AppendDetail(address, FirstTag(tags, "addr:unit", "unit", "addr:door", "addr:room"), "铺位 ");
            return Limit(address, 160);
        }

        private static string AppendDetail(string address, string detail, string label)
        {
            if (detail.Length == 0 || address.IndexOf(label + detail, StringComparison.OrdinalIgnoreCase) >= 0) return address;
            return (address.Length == 0 ? String.Empty : address + " · ") + label + detail;
        }

        private static bool TryIdentity(IDictionary<string, object> element, string type, out string id)
        {
            id = String.Empty;
            if (type != "node" && type != "way" && type != "relation") return false;
            object value = Field(element, "id");
            if (!(value is int) && !(value is long)) return false;

            long number = Convert.ToInt64(value, CultureInfo.InvariantCulture);
            if (number < 1) return false;
            id = "osm-" + type + "-" + number.ToString(CultureInfo.InvariantCulture);
            return true;
        }

        private static bool TryLocation(IDictionary<string, object> element, string type, out double latitude, out double longitude)
        {
            var point = type == "node" ? element : Field(element, "center") as IDictionary<string, object>;
            latitude = longitude = 0;
            return TryNumber(Field(point, "lat"), out latitude) && TryNumber(Field(point, "lon"), out longitude) &&
                IsCoordinate(latitude, longitude);
        }

        private static bool TryNumber(object value, out double number)
        {
            number = 0;
            if (!(value is double) && !(value is decimal) && !(value is int) && !(value is long)) return false;
            number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
            return true;
        }

        private static object Field(IDictionary<string, object> data, string key)
        {
            object value;
            return data != null && data.TryGetValue(key, out value) ? value : null;
        }

        private static string Tag(IDictionary<string, object> data, string key)
        {
            string value = Field(data, key) as string;
            return value == null ? String.Empty : value.Trim();
        }

        private static string FirstTag(IDictionary<string, object> tags, params string[] keys)
        {
            foreach (string key in keys)
            {
                string value = Tag(tags, key);
                if (value.Length > 0) return value;
            }
            return String.Empty;
        }

        private static string Limit(string value, int length)
        {
            if (value.Length <= length) return value;
            if (Char.IsHighSurrogate(value[length - 1])) length--;
            return value.Substring(0, length).TrimEnd();
        }

        private static bool IsCoordinate(double latitude, double longitude)
        {
            return latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
        }

        private static double DistanceKm(double startLat, double startLng, double endLat, double endLng)
        {
            const double toRadians = Math.PI / 180;
            const double earthRadiusKm = 6371.0088;
            double latitude = Math.Sin((endLat - startLat) * toRadians / 2);
            double longitude = Math.Sin((endLng - startLng) * toRadians / 2);
            double haversine = latitude * latitude +
                Math.Cos(startLat * toRadians) * Math.Cos(endLat * toRadians) * longitude * longitude;
            return 2 * earthRadiusKm * Math.Asin(Math.Sqrt(Math.Min(1, haversine)));
        }
    }
}
